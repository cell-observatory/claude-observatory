package com.cellobservatory.observatory.ui.inline

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.services.PlacementsCache
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.Diffs
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.icons.AllIcons
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.components.Service
import com.intellij.openapi.diff.DiffColors
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.editor.event.EditorFactoryEvent
import com.intellij.openapi.editor.event.EditorFactoryListener
import com.intellij.openapi.editor.event.EditorMouseEvent
import com.intellij.openapi.editor.event.EditorMouseListener
import com.intellij.openapi.editor.markup.GutterIconRenderer
import com.intellij.openapi.editor.markup.HighlighterLayer
import com.intellij.openapi.editor.markup.RangeHighlighter
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.util.Disposer
import com.intellij.util.Alarm
import java.awt.Font
import javax.swing.Icon

private const val MAX_INLINE_LINES = 20_000 // same guard as the VS Code overlay

/**
 * The inline review overlay: per pending edit, a clickable "✓ Keep #N · ↩ Undo · ⇄ Diff" lens
 * above its first line (block inlay — the stable API, chosen over experimental Code Vision),
 * a changed-line background + gutter action icon, and a dim " ✨ #N" end-of-line marker.
 * Placement geometry comes from PlacementsCache (CLI locate); re-renders on store changes,
 * document edits (debounced 250ms), and cache updates.
 */
@Service(Service.Level.PROJECT)
class InlineOverlay(private val project: Project) : Disposable {

    private val highlighters = HashMap<Editor, MutableList<RangeHighlighter>>()
    private val inlays = HashMap<Editor, MutableList<Inlay<*>>>()
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private var installed = false

    fun install() {
        if (installed) return
        installed = true
        val factory = EditorFactory.getInstance()
        factory.addEditorFactoryListener(object : EditorFactoryListener {
            override fun editorCreated(event: EditorFactoryEvent) {
                if (event.editor.project === project) scheduleRefresh()
            }

            override fun editorReleased(event: EditorFactoryEvent) = clear(event.editor)
        }, this)
        factory.eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                if (editorsFor(event.document).isNotEmpty()) scheduleRefresh()
            }
        }, this)
        factory.eventMulticaster.addEditorMouseListener(object : EditorMouseListener {
            override fun mouseClicked(e: EditorMouseEvent) = handleLensClick(e)
        }, this)
        ObservatoryService.getInstance(project).addListener { refreshAll() }
        PlacementsCache.getInstance(project).addUpdateListener { file ->
            projectEditors().filter { pathOf(it) == file }.forEach { render(it) }
        }
        refreshAll()
    }

    fun refreshAll() = projectEditors().forEach { render(it) }

    private fun editorsFor(document: Document) =
        EditorFactory.getInstance().getEditors(document, project).toList()

    private fun projectEditors() =
        EditorFactory.getInstance().allEditors.filter { it.project === project && !it.isDisposed }

    private fun pathOf(editor: Editor): String? =
        FileDocumentManager.getInstance().getFile(editor.document)?.path

    private fun scheduleRefresh() {
        alarm.cancelAllRequests()
        alarm.addRequest({ refreshAll() }, 250)
    }

    private fun render(editor: Editor) {
        clear(editor)
        if (editor.isDisposed || !ObservatorySettings.instance.state.inlineReview) return
        if (editor.document.lineCount > MAX_INLINE_LINES) return
        val file = pathOf(editor) ?: return
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return
        val pending = service.log().filter { it.pending && it.file == file }
        if (pending.isEmpty()) return
        val placements = PlacementsCache.getInstance(project)
            .placementsFor(file, editor.document.text, editor.document.modificationStamp.toString())
            ?: return // stale — the cache listener re-renders when locate lands

        val markup = editor.markupModel
        val insertedBg = editor.colorsScheme.getAttributes(DiffColors.DIFF_INSERTED)?.backgroundColor
        val hs = highlighters.getOrPut(editor) { mutableListOf() }
        val ins = inlays.getOrPut(editor) { mutableListOf() }
        for (p in placements) {
            val rec = pending.find { it.id == p.id } ?: continue
            val lines = p.lines.filter { it < editor.document.lineCount }
            if (lines.isEmpty()) continue
            for (line in lines) {
                val h = markup.addLineHighlighter(line, HighlighterLayer.CARET_ROW - 1, TextAttributes(null, insertedBg, null, null, Font.PLAIN))
                h.setErrorStripeMarkColor(insertedBg)
                hs.add(h)
            }
            val first = lines.min()
            val gutter = markup.addLineHighlighter(first, HighlighterLayer.CARET_ROW - 1, null)
            gutter.gutterIconRenderer = EditGutterRenderer(project, session, rec)
            hs.add(gutter)
            editor.inlayModel.addBlockElement(
                editor.document.getLineStartOffset(first), false, true, 0,
                LensRenderer(project, session, rec),
            )?.let { ins.add(it) }
            editor.inlayModel.addAfterLineEndElement(
                editor.document.getLineEndOffset(lines.max()), true, StarRenderer(rec.id),
            )?.let { ins.add(it) }
        }
    }

    private fun clear(editor: Editor) {
        highlighters.remove(editor)?.forEach { h -> runCatching { editor.markupModel.removeHighlighter(h) } }
        inlays.remove(editor)?.forEach { runCatching { Disposer.dispose(it) } }
    }

    private fun handleLensClick(e: EditorMouseEvent) {
        val editor = e.editor
        if (editor.project !== project) return
        val inlay = editor.inlayModel.getElementAt(e.mouseEvent.point) ?: return
        val lens = inlay.renderer as? LensRenderer ?: return
        val bounds = inlay.bounds ?: return
        lens.actionAt(e.mouseEvent.x - bounds.x)?.invoke()
        e.consume()
    }

    override fun dispose() {
        projectEditors().forEach { clear(it) }
    }

    companion object {
        fun getInstance(project: Project): InlineOverlay = project.getService(InlineOverlay::class.java)
    }
}

/** Gutter icon on an edit's first line: click for the Keep/Undo/Diff popup. */
private class EditGutterRenderer(
    private val project: Project,
    private val session: String,
    private val rec: EditRecord,
) : GutterIconRenderer() {
    override fun getIcon(): Icon = AllIcons.General.Modified
    override fun getTooltipText() = "Claude edit #${rec.id} · ${rec.tool} — click for actions"
    override fun equals(other: Any?) = (other as? EditGutterRenderer)?.rec?.id == rec.id
    override fun hashCode() = rec.id
    override fun isNavigateAction() = true

    override fun getClickAction(): AnAction = object : AnAction("Claude Edit #${rec.id}") {
        override fun actionPerformed(e: AnActionEvent) {
            val group = DefaultActionGroup(
                simple("Keep #${rec.id}", AllIcons.Actions.Checked) { ReviewOps.keep(project, session, rec.id) },
                simple("Undo #${rec.id}", AllIcons.Actions.Rollback) { ReviewOps.undoOrRedo(project, session, rec, redo = false) },
                simple("Diff #${rec.id}", AllIcons.Actions.Diff) { Diffs.show(project, session, rec) },
            )
            JBPopupFactory.getInstance()
                .createActionGroupPopup(
                    "Claude Edit #${rec.id}", group, e.dataContext,
                    JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, true,
                )
                .showInBestPositionFor(e.dataContext)
        }
    }

    private fun simple(text: String, icon: Icon, run: () -> Unit) = object : AnAction(text, null, icon) {
        override fun actionPerformed(e: AnActionEvent) = run()
    }
}
