package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.EditRecord
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.tools.fragmented.UnifiedDiffTool
import com.intellij.diff.tools.util.base.TextDiffSettingsHolder
import com.intellij.diff.util.DiffUserDataKeys
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.InplaceButton
import com.intellij.ui.SimpleColoredComponent
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.beans.PropertyChangeListener
import java.io.File
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.ScrollPaneConstants

/** One unit of the stacked review WITHOUT its texts — blobs are read per PAGE. A 2,922-unit session
 *  must not read (or hold) every blob pair up front, and must never build thousands of Swing diff
 *  panels in one EDT breath: the eager version measurably froze the IDE. */
data class ReviewAllSpec(val rec: EditRecord, val rel: String, val delta: Int)

/** The payload behind the "Open all in editor" tab. A snapshot of the moment it opened — reviewing
 *  from it mutates the store (the panels refresh), but the tab itself does not re-derive. */
class ReviewAllVirtualFile(
    val session: String,
    val specs: List<ReviewAllSpec>,
    name: String,
) : LightVirtualFile(name) {
    init {
        isWritable = false
    }
}

/**
 * "Open all in editor", as ONE editor tab stacking the listed pending units: a header row per unit
 * (Keep / Undo / Chat, then #id · path) above an embedded hunks-only unified diff.
 *
 * PAGED, ten blocks at a time: each page's blob pairs are read on a pooled thread, its panels built
 * on the EDT, and a "next ten" button carries on — so opening the tab costs ten diffs however large
 * the session, and a missing blob skips its block with a warning instead of rendering as an empty
 * side. Built from PUBLIC diff APIs (`DiffManager.createRequestPanel`) — the platform's combined
 * diff is internal surface with no per-block action seam.
 */
class ReviewAllEditor(private val project: Project, private val file: ReviewAllVirtualFile) :
    UserDataHolderBase(), FileEditor {

    private companion object {
        const val PAGE = 10
    }

    // TRACKS VIEWPORT WIDTH: the blocks scale with the window (headers here are short "#id · rel",
    // so nothing needs the horizontal-overflow escape the Review rows once used — without tracking,
    // BoxLayout sized blocks to their preferred width and a wide window left dead space beside every
    // diff).
    private val stack = object : JPanel(), javax.swing.Scrollable {
        init {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(8, 10)
        }
        override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
        override fun getScrollableUnitIncrement(visible: java.awt.Rectangle, orientation: Int, direction: Int): Int = JBUI.scale(19)
        override fun getScrollableBlockIncrement(visible: java.awt.Rectangle, orientation: Int, direction: Int): Int = visible.height
        override fun getScrollableTracksViewportWidth(): Boolean = true
        override fun getScrollableTracksViewportHeight(): Boolean = false
    }
    // Horizontal scrollbar NEVER: with the stack width-tracking the viewport it could never engage,
    // and a policy that can never fire is a claim the layout does not honor.
    private val scroll = JBScrollPane(
        stack,
        ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED,
        ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER,
    )
    private val more = JPanel(FlowLayout(FlowLayout.LEFT, 4, 0)).apply {
        alignmentX = JComponent.LEFT_ALIGNMENT
    }
    private var built = 0

    /** Set by [dispose]: a page whose blob read lands AFTER the tab closed (re-open replaces the
     *  file; the platform disposes this editor) must not build panels parented to a disposed
     *  Disposable — `Disposer.register` throws on that. */
    @Volatile private var disposed = false

    init {
        addPage()
    }

    /** Read the NEXT page's blobs off the EDT, then append its panels — the whole point of paging. */
    private fun addPage() {
        val pageSpecs = file.specs.drop(built).take(PAGE)
        built += pageSpecs.size
        stack.remove(more)
        stack.revalidate()
        stack.repaint() // the button leaves the screen NOW, not when the read returns — a painted-but-dead button reads as broken
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val sides = pageSpecs.map {
                StoreReader.readBlobOrNull(file.session, it.rec.beforeBlob) to
                    StoreReader.readBlobOrNull(file.session, it.rec.afterBlob)
            }
            app.invokeLater {
                if (disposed || project.isDisposed) return@invokeLater
                val missing = mutableListOf<Int>()
                pageSpecs.forEachIndexed { i, spec ->
                    val (before, after) = sides[i]
                    if (before == null || after == null) {
                        missing.add(spec.rec.id)
                        return@forEachIndexed
                    }
                    stack.add(block(spec, before, after))
                }
                if (missing.isNotEmpty()) {
                    ReviewOps.notify(
                        project,
                        "Skipped ${missing.joinToString(", ") { "#$it" }} — blob(s) missing from the store",
                        NotificationType.WARNING,
                    )
                }
                val left = file.specs.size - built
                if (left > 0) {
                    more.removeAll()
                    more.add(InplaceButton("Build the next ${minOf(PAGE, left)} diffs", NavTint.tint(AllIcons.Actions.MoveDown, NavTint.BLUE)) { addPage() })
                    more.add(JBLabel("$left more not built yet — ten at a time keeps this tab instant"))
                    stack.add(more)
                }
                stack.revalidate()
                stack.repaint()
            }
        }
    }

    // DumbAware: reviewing does not touch indexes, and an action greyed out during indexing beside a
    // button that still works is the kind of inconsistency that reads as a bug.
    private fun act(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    private fun block(spec: ReviewAllSpec, before: String, after: String): JPanel {
        val rec = spec.rec
        val factory = DiffContentFactory.getInstance()
        val type = FileTypeManager.getInstance().getFileTypeByFileName(File(rec.file).name)
        val request = SimpleDiffRequest(
            "#${rec.id} · ${spec.rel}",
            factory.create(project, before, type),
            factory.create(project, after, type),
            if (rec.beforeBlob == null) "(new file)" else "before",
            if (rec.afterBlob == null) "(deleted)" else "after",
        ).apply {
            // Unified, always: this is a reading column of stacked blocks, and side-by-side halves
            // the width of every one of them.
            putUserData(DiffUserDataKeysEx.FORCE_DIFF_TOOL, UnifiedDiffTool.INSTANCE)
            // …and the same verbs on the embedded viewer's OWN toolbar, where a reader coming from
            // the single-diff window looks for them.
            putUserData(
                DiffUserDataKeys.CONTEXT_ACTIONS,
                listOf(
                    act("Keep #${rec.id}", NavTint.KEEP) { ReviewOps.keep(project, file.session, rec.id, advance = false) },
                    act("Undo #${rec.id}", NavTint.UNDO) { ReviewOps.undoOrRedo(project, file.session, rec, redo = false, advance = false) },
                    act("Chat About #${rec.id}", NavTint.CHAT) { ReviewOps.chatAbout(project, file.session, rec.id) },
                ),
            )
        }
        val header = SimpleColoredComponent().apply {
            append("#${rec.id}  ", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
            append(spec.rel, SimpleTextAttributes.REGULAR_ATTRIBUTES)
            // The stack width-tracks the window, so a long path CLIPS at the pane edge — the full
            // text rides the tooltip instead of a horizontal scroll nothing else here needs.
            toolTipText = "#${rec.id} · ${spec.rel}"
        }
        // Buttons LEFT of the path, LABELLED: bare icons here were reported as "no options for each
        // diff" — a verb nobody recognizes is a verb nobody has. They stay in reach however narrow
        // the pane, and a clipped path costs readability, never an action.
        val btns = JPanel(FlowLayout(FlowLayout.LEFT, 3, 0)).apply {
            add(JButton("✓ Keep").apply {
                toolTipText = "Keep #${rec.id}"
                addActionListener { ReviewOps.keep(project, file.session, rec.id, advance = false) }
            })
            add(JButton("↩ Undo").apply {
                toolTipText = "Surgically revert #${rec.id}"
                addActionListener { ReviewOps.undoOrRedo(project, file.session, rec, redo = false, advance = false) }
            })
            add(JButton("💬 Chat").apply {
                toolTipText = "Assemble #${rec.id}'s context on the clipboard — no tokens spent"
                addActionListener { ReviewOps.chatAbout(project, file.session, rec.id) }
            })
        }
        val top = JPanel(BorderLayout()).apply {
            add(btns, BorderLayout.WEST)
            add(header, BorderLayout.CENTER)
            border = JBUI.Borders.empty(6, 0, 2, 0)
        }
        val diffPanel = DiffManager.getInstance().createRequestPanel(project, this, null).apply {
            putContextHints(
                TextDiffSettingsHolder.TextDiffSettings.KEY,
                TextDiffSettingsHolder.TextDiffSettings().apply { isExpandByDefault = false },
            )
            setRequest(request)
        }
        // Sized from the unit's ±count: changed lines + fold/context rows, capped so one huge block
        // cannot swallow the column (it scrolls internally past the cap). HEIGHT ONLY — the width
        // follows the viewport (the stack width-tracks, so blocks scale with the window).
        // Tight: changed lines + a little fold chrome. The looser +6/base-36 sizing left a band of
        // dead whitespace under every small diff.
        val h = JBUI.scale(30) + JBUI.scale(19) * minOf(spec.delta + 3, 30)
        return object : JPanel(BorderLayout()) {
            override fun getPreferredSize(): Dimension = Dimension(super.getPreferredSize().width, h)
            override fun getMaximumSize(): Dimension = Dimension(Int.MAX_VALUE, h)
        }.apply {
            add(top, BorderLayout.NORTH)
            add(diffPanel.component, BorderLayout.CENTER)
            alignmentX = JComponent.LEFT_ALIGNMENT
            border = JBUI.Borders.emptyBottom(10)
        }
    }

    override fun getComponent(): JComponent = scroll
    override fun getPreferredFocusedComponent(): JComponent = scroll
    override fun getName(): String = "Claude Review"
    override fun setState(state: FileEditorState) {}
    override fun isModified(): Boolean = false
    override fun isValid(): Boolean = true
    override fun addPropertyChangeListener(listener: PropertyChangeListener) {}
    override fun removePropertyChangeListener(listener: PropertyChangeListener) {}
    override fun dispose() {
        disposed = true
    }
    override fun getFile(): VirtualFile = file
}

class ReviewAllEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean = file is ReviewAllVirtualFile
    override fun createEditor(project: Project, file: VirtualFile): FileEditor =
        ReviewAllEditor(project, file as ReviewAllVirtualFile)
    override fun getEditorTypeId(): String = "claude-observatory-review-all"
    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR
}
