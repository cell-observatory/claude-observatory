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
    private val renderSig = HashMap<Editor, String>() // skip identical re-renders (kills flicker)
    private val editRegions = HashMap<Editor, List<Pair<IntRange, EditRecord>>>() // hover-card hit zones
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, this)
    private var installed = false
    private var hoverLens: LensRenderer? = null
    private var hoverInlay: Inlay<*>? = null

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
        factory.eventMulticaster.addEditorMouseMotionListener(object : com.intellij.openapi.editor.event.EditorMouseMotionListener {
            override fun mouseMoved(e: EditorMouseEvent) = handleLensHover(e)
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
        if (editor.isDisposed) return clear(editor)
        val file = pathOf(editor)
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
        val pending = if (file == null || session == null) emptyList()
        else service.log().filter { it.pending && it.file == file }
        if (!ObservatorySettings.instance.state.inlineReview ||
            editor.document.lineCount > MAX_INLINE_LINES ||
            file == null || session == null || pending.isEmpty()
        ) {
            clear(editor)
            return
        }
        val placements = PlacementsCache.getInstance(project)
            .placementsFor(file, editor.document.text, editor.document.modificationStamp.toString())
            ?: return // stale — KEEP the previous artifacts (RangeMarkers track edits) until locate lands
        // Identical geometry ⇒ nothing to do. Rebuilding anyway would flicker on every keystroke.
        val sig = "$session|$file|" + placements.joinToString(";") { "${it.id}:${it.lines}" } +
            "|" + pending.joinToString(",") { it.id.toString() }
        if (renderSig[editor] == sig) return
        clear(editor)
        renderSig[editor] = sig

        val markup = editor.markupModel
        val insertedBg = editor.colorsScheme.getAttributes(DiffColors.DIFF_INSERTED)?.backgroundColor
        val hs = highlighters.getOrPut(editor) { mutableListOf() }
        val ins = inlays.getOrPut(editor) { mutableListOf() }
        val regions = mutableListOf<Pair<IntRange, EditRecord>>()
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
                editor.document.getLineEndOffset(lines.max()), true, StarRenderer(project, session, rec),
            )?.let { ins.add(it) }
            regions.add(lines.min()..lines.max() to rec)
        }
        editRegions[editor] = regions
    }

    private fun clear(editor: Editor) {
        renderSig.remove(editor)
        editRegions.remove(editor)
        highlighters.remove(editor)?.forEach { h -> runCatching { editor.markupModel.removeHighlighter(h) } }
        inlays.remove(editor)?.forEach { runCatching { Disposer.dispose(it) } }
    }

    private fun handleLensClick(e: EditorMouseEvent) {
        val editor = e.editor
        if (editor.project !== project) return
        val inlay = editor.inlayModel.getElementAt(e.mouseEvent.point) ?: return
        when (val renderer = inlay.renderer) {
            is LensRenderer -> {
                val bounds = inlay.bounds ?: return
                renderer.actionAt(e.mouseEvent.x - bounds.x)?.invoke()
                e.consume()
            }
            is StarRenderer -> {
                inlay.bounds?.let { b -> EditHoverCard.show(project, renderer.session, renderer.rec, toScreen(editor, b)) }
                e.consume()
            }
        }
    }

    private fun toScreen(editor: Editor, bounds: java.awt.Rectangle): java.awt.Rectangle {
        val screen = java.awt.Rectangle(bounds)
        val loc = editor.contentComponent.locationOnScreen
        screen.translate(loc.x, loc.y)
        return screen
    }

    /** Hand cursor + link styling on the hovered lens action. */
    private fun handleLensHover(e: EditorMouseEvent) {
        val editor = e.editor
        if (editor.project !== project) return
        val inlay = editor.inlayModel.getElementAt(e.mouseEvent.point)
        val lens = inlay?.renderer as? LensRenderer
        val bounds = inlay?.bounds
        val idx = if (lens != null && bounds != null) lens.segmentAt(e.mouseEvent.x - bounds.x) else -1
        // leave the previous lens
        if (hoverLens != null && hoverLens !== lens) {
            if (hoverLens!!.setHover(-1)) hoverInlay?.bounds?.let { editor.contentComponent.repaint(it) }
            hoverLens = null
            hoverInlay = null
        }
        if (lens != null) {
            hoverLens = lens
            hoverInlay = inlay
            if (lens.setHover(idx)) bounds?.let { editor.contentComponent.repaint(it) }
        }
        // Hovering the ✨ marker OR any highlighted line of a pending edit shows the edit card
        // (full reasoning + actions) — parity with the VS Code hover. Anchored to the edit's whole
        // text region so the card stays put while the mouse moves within the edit, and the card's
        // mouse-out callback dismisses it once the mouse leaves both the region and the card.
        val star = inlay?.renderer as? StarRenderer
        if (star != null) {
            inlay.bounds?.let { b -> EditHoverCard.show(project, star.session, star.rec, toScreen(editor, b)) }
        } else if (inlay == null && e.area == com.intellij.openapi.editor.event.EditorMouseEventArea.EDITING_AREA) {
            hoveredEditAt(editor, e)?.let { (range, rec) ->
                val session = ObservatoryService.getInstance(project).currentSession()
                if (session != null) EditHoverCard.show(project, session, rec, regionScreenRect(editor, range))
            }
        }
        editor.contentComponent.cursor =
            if (idx >= 0 || star != null) java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            else java.awt.Cursor.getDefaultCursor()
    }

    private fun hoveredEditAt(editor: Editor, e: EditorMouseEvent): Pair<IntRange, EditRecord>? {
        val regions = editRegions[editor] ?: return null
        val line = editor.xyToLogicalPosition(e.mouseEvent.point).line
        if (line >= editor.document.lineCount) return null
        return regions.find { line in it.first }
    }

    /** Screen rectangle spanning an edit's lines — the hover card's keep-open anchor zone. */
    private fun regionScreenRect(editor: Editor, lines: IntRange): java.awt.Rectangle {
        val top = editor.logicalPositionToXY(com.intellij.openapi.editor.LogicalPosition(lines.first, 0)).y
        val bottom = editor.logicalPositionToXY(com.intellij.openapi.editor.LogicalPosition(lines.last, 0)).y + editor.lineHeight
        val rect = java.awt.Rectangle(0, top, editor.contentComponent.width, bottom - top)
        return toScreen(editor, rect)
    }

    override fun dispose() {
        projectEditors().forEach { clear(it) }
    }

    companion object {
        fun getInstance(project: Project): InlineOverlay = project.getService(InlineOverlay::class.java)
    }
}

/** Gutter icon on an edit's first line: click opens the edit card; right-click a native menu. */
private class EditGutterRenderer(
    private val project: Project,
    private val session: String,
    private val rec: EditRecord,
) : GutterIconRenderer() {
    override fun getIcon(): Icon = com.cellobservatory.observatory.ui.Icons.Microscope
    override fun getTooltipText() = "Claude edit #${rec.id} · ${rec.tool} — click for actions"
    override fun equals(other: Any?) = (other as? EditGutterRenderer)?.rec?.id == rec.id
    override fun hashCode() = rec.id
    override fun isNavigateAction() = true

    // Right-click path: the platform renders this menu natively (reasoning lives on the card).
    override fun getPopupMenuActions(): DefaultActionGroup = DefaultActionGroup(
        simple("Keep #${rec.id}", AllIcons.Actions.Checked) { ReviewOps.keep(project, session, rec.id) },
        simple("Undo #${rec.id}", AllIcons.Actions.Rollback) { ReviewOps.undoOrRedo(project, session, rec, redo = false) },
        simple("Diff #${rec.id}", AllIcons.Actions.Diff) { Diffs.show(project, session, rec) },
        simple("Chat About #${rec.id}", AllIcons.General.Balloon) { ReviewOps.chatAbout(project, session, rec.id) },
    )

    private fun simple(text: String, icon: Icon, run: () -> Unit) = object : AnAction(text, null, icon) {
        override fun actionPerformed(e: AnActionEvent) = run()
    }

    // Left-click path: open the edit card anchored on the ACTUAL mouse location — a gutter
    // click's data context has no usable position for showInBestPositionFor().
    override fun getClickAction(): AnAction = object : AnAction("Claude Edit #${rec.id}") {
        override fun actionPerformed(e: AnActionEvent) {
            val mouse = e.inputEvent as? java.awt.event.MouseEvent ?: return
            val at = java.awt.Rectangle(mouse.locationOnScreen, java.awt.Dimension(1, 1))
            EditHoverCard.show(project, session, rec, at)
        }
    }
}
