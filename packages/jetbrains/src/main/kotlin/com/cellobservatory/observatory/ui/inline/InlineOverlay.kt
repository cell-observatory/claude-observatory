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
import com.intellij.ui.JBColor
import com.intellij.util.Alarm
import java.awt.Color
import java.awt.Font
import javax.swing.Icon

private const val MAX_INLINE_LINES = 20_000 // same guard as the VS Code overlay

// Claude's signature error-stripe color — a distinct coral so Claude's edits stand out on the overview
// ruler instead of blending into VCS markers. Parity with the VS Code CLAUDE_MARK_COLOR.
private val CLAUDE_MARK = JBColor(Color(0xCC785C), Color(0xE0906F))

// Whole-line fill on Claude's added/changed lines — a clearly visible green (light/dark) so the edited
// region reads at a glance. JBColor can't alpha-blend like VS Code, so these are solid tints picked to
// match the strengthened VS Code ADDED_LINE_BG (rgba green @ 0.30, blended over the editor bg).
private val ADDED_LINE_BG = JBColor(Color(0xCD, 0xE4, 0xD0), Color(0x2F, 0x47, 0x33))

/**
 * The inline review overlay: per pending edit, a clickable "✓ Keep #N · ↩ Undo · 💬 Chat · ⧉ View diff" lens
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
    var heatmapOn = false // "file heatmap": dim unmodified lines so Claude's edits stand out

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

    /** Toggle the file heatmap (dim unmodified lines). Parity with VS Code's tab-bar 🔥 toggle. */
    fun toggleHeatmap() {
        heatmapOn = !heatmapOn
        renderSig.clear() // force a rebuild so the dim appears/disappears
        refreshAll()
        // Confirm the toggle out loud — spotlight only dims files WITH pending edits, so on a clean
        // file a silent toggle reads as "the button does nothing".
        com.cellobservatory.observatory.ui.ReviewOps.notify(
            project,
            if (heatmapOn) "Spotlight on — unedited lines dim in files with pending Claude edits"
            else "Spotlight off",
        )
    }

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
            "|" + pending.joinToString(",") { it.id.toString() } + "|hm=$heatmapOn"
        if (renderSig[editor] == sig) return
        clear(editor)
        renderSig[editor] = sig

        val markup = editor.markupModel
        val hs = highlighters.getOrPut(editor) { mutableListOf() }
        val ins = inlays.getOrPut(editor) { mutableListOf() }
        val regions = mutableListOf<Pair<IntRange, EditRecord>>()
        // Only the LATEST edit per anchor line gets a gutter star + inline lens: several edits often
        // land on one line, and one menu per edit is noisy/ambiguous. Older same-line edits stay in the
        // Timeline; undoing the latest surgically reveals the previous state (its lens then takes over).
        val latestByAnchor = HashMap<Int, Int>()
        for (p in placements) {
            val ls = p.lines.filter { it < editor.document.lineCount }
            if (ls.isEmpty()) continue
            val anchor = ls.min()
            latestByAnchor[anchor] = maxOf(latestByAnchor[anchor] ?: Int.MIN_VALUE, p.id)
        }
        for (p in placements) {
            val rec = pending.find { it.id == p.id } ?: continue
            val lines = p.lines.filter { it < editor.document.lineCount }
            if (lines.isEmpty()) continue
            // A SUBTLE green line fill (toned down, not the default diff green) + a coral error-stripe mark
            // per changed line, so a file Claude edited heavily doesn't drown in color. Shown for ALL edits.
            for (line in lines) {
                val h = markup.addLineHighlighter(line, HighlighterLayer.CARET_ROW - 1, TextAttributes(null, ADDED_LINE_BG, null, null, Font.PLAIN))
                h.setErrorStripeMarkColor(CLAUDE_MARK)
                hs.add(h)
            }
            val first = lines.min()
            regions.add(lines.min()..lines.max() to rec)
            // Gutter star + lens only for the latest edit anchored at this line (others -> Timeline).
            if (rec.id != latestByAnchor[first]) continue
            val gutter = markup.addLineHighlighter(first, HighlighterLayer.CARET_ROW - 1, null)
            gutter.gutterIconRenderer = EditGutterRenderer(project, session, rec)
            hs.add(gutter)
            editor.inlayModel.addBlockElement(
                editor.document.getLineStartOffset(first), false, true, 0,
                LensRenderer(project, session, rec),
            )?.let { ins.add(it) }
        }
        // Heatmap: dim every UNMODIFIED line (flat grey, no syntax colors) so Claude's edits stand out.
        // JetBrains can't alpha-blend text, so "dim" is a muted foreground (parity with VS Code's opacity).
        // The layer must sit ABOVE HighlighterLayer.SYNTAX (2000) — a foreground at CARET_ROW-2 (998)
        // loses the merge to syntax colors and the dim never shows (the 0.8.x "Spotlight does nothing"
        // bug); SELECTION-1 wins over syntax + inspections while still yielding to the selection.
        if (heatmapOn) {
            val changed = placements.flatMap { it.lines }.filter { it < editor.document.lineCount }.toHashSet()
            val dimAttrs = TextAttributes(com.intellij.ui.JBColor.GRAY, null, null, null, Font.PLAIN)
            var runStart = -1
            fun flushDim(end: Int) {
                if (runStart in 0..end) {
                    hs.add(
                        markup.addRangeHighlighter(
                            editor.document.getLineStartOffset(runStart),
                            editor.document.getLineEndOffset(end),
                            HighlighterLayer.SELECTION - 1, dimAttrs,
                            com.intellij.openapi.editor.markup.HighlighterTargetArea.EXACT_RANGE,
                        )
                    )
                }
                runStart = -1
            }
            for (line in 0 until editor.document.lineCount) {
                if (line in changed) flushDim(line - 1)
                else if (runStart < 0) runStart = line
            }
            flushDim(editor.document.lineCount - 1)
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
        val renderer = inlay.renderer
        if (renderer is LensRenderer) {
            val bounds = inlay.bounds ?: return
            renderer.actionAt(e.mouseEvent.x - bounds.x)?.invoke()
            e.consume()
        }
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
        editor.contentComponent.cursor =
            if (idx >= 0) java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR)
            else java.awt.Cursor.getDefaultCursor()
    }

    override fun dispose() {
        projectEditors().forEach { clear(it) }
    }

    companion object {
        fun getInstance(project: Project): InlineOverlay = project.getService(InlineOverlay::class.java)
    }
}

/** ✨ gutter star at an edit's first line: click opens the inline diff; right-click a native menu. */
private class EditGutterRenderer(
    private val project: Project,
    private val session: String,
    private val rec: EditRecord,
) : GutterIconRenderer() {
    override fun getIcon(): Icon = com.cellobservatory.observatory.ui.Icons.Star
    override fun getTooltipText() = "Claude edit #${rec.id} · ${rec.tool} — click to see the changes"
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

    // Left-click path: show the edit's before ⟷ after diff (the reasoning + actions now live on the
    // inline lens above the edit; right-click still opens the full Keep/Undo/Diff/Chat menu).
    override fun getClickAction(): AnAction = object : AnAction("Claude Edit #${rec.id}") {
        override fun actionPerformed(e: AnActionEvent) = Diffs.show(project, session, rec)
    }
}
