package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.inline.InlineOverlay
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.JBColor
import com.intellij.util.IconUtil
import java.awt.Color
import java.io.File
import javax.swing.Icon

/**
 * Semantic tints for the nav-bar icons (the MT/chart palette — the same hexes the VS Code toolbar reads
 * from --mt-*): keep/accept GREEN · undo/reject RED · nav chevrons BLUE · clear ORANGE · search/spotlight
 * PURPLE. Shared by the review nav bar and the Overview's bulk actions so every surface color-groups
 * identically (cross-editor parity — the VS Code webview tints the same buttons the same colors).
 */
internal object NavTint {
    val GREEN = JBColor(Color(0x3FB950), Color(0x3FB950))
    val RED = JBColor(Color(0xE5534B), Color(0xE5534B))
    val BLUE = JBColor(Color(0x4C8BF5), Color(0x4C8BF5))
    val ORANGE = JBColor(Color(0xD9822B), Color(0xE6A44C)) // brighter on dark — the dull dark orange read poorly
    val PURPLE = JBColor(Color(0x9A6AC2), Color(0x9A6AC2))
    fun tint(icon: Icon, color: Color): Icon = IconUtil.colorize(icon, color)

    // ONE glyph+tint per ACTION — and no glyph serves two different actions (user rule 2026-07-16).
    // Used by every surface (nav bars, panel toolbars, context menus, the editor banner, the floating
    // lens) so the same action always looks the same. Three scope tiers, mirroring the VS Code
    // codicons: per-edit Keep ✓/Undo ↩ · scoped (file/folder) Accept ✓✓/Reject ✕ · session-wide
    // Accept All (commit)/Revert All (history, VS Code $(timeline-view-icon)). Row STATE badges stay
    // neutral except kept-green (a reverted STATE is not a destructive ACTION — it never wears red).
    val KEEP: Icon = tint(AllIcons.Actions.Checked, GREEN)
    val ACCEPT_FILE: Icon = tint(Icons.CheckAll, GREEN)
    val ACCEPT_ALL: Icon = tint(AllIcons.Actions.Commit, GREEN)
    val UNDO: Icon = tint(AllIcons.Actions.Rollback, RED)
    val REJECT: Icon = tint(AllIcons.Actions.Cancel, RED)
    val REVERT_ALL: Icon = tint(AllIcons.Vcs.History, RED)
    val CLEAR: Icon = tint(AllIcons.Actions.GC, ORANGE)
    val SEARCH: Icon = tint(AllIcons.Actions.Find, PURPLE)
    val SPOTLIGHT: Icon = tint(AllIcons.Actions.IntentionBulb, PURPLE)
    /** Chat = a speech balloon (VS Code's comment-discussion) — NOT the bulb, which is Spotlight's. */
    val CHAT: Icon = tint(AllIcons.General.Balloon, PURPLE)
}

/**
 * The compact step-through review toolbar — Search, Diff axis (▲ n/m ▼), File axis (◀ n/m ▶), Keep/Undo
 * this edit, Accept/Reject File, Spotlight — the VS Code status-bar order. The status-bar widget
 * (ObservatoryActionsWidgetFactory) consumes [buildGroup] flat; the Overview title bar (ChangeMapPanel)
 * composes the SAME actions into its five spaced groups — one behavior, two compositions, and both
 * editors step through review identically (cross-editor parity, single implementation).
 *
 * Tiers, driven by per-action visibility:
 *   • session tier     — File axis (◀ n/m ▶), Spotlight, Search — whenever any edit is pending.
 *   • active-file tier — Diff axis (▲ n/m ▼), Keep/Undo this edit, Accept/Reject File — when the OPEN file
 *     has pending edits.
 * The one per-host difference is whether the session-wide clear rides along — see [buildGroup]'s [sessionClear].
 *
 * Each HOST owns its own instance and thus its own nav position ([navEditId]); [onNavChange] fires after a
 * Diff/File step so the host can refresh its toolbar immediately.
 */
class ReviewNavBar(private val project: Project, private val onNavChange: () -> Unit = {}) {

    private val service get() = ObservatoryService.getInstance(project)

    // The pending edit the Diff axis is parked on within the open file (mirrors the VS Code navEditId).
    @Volatile private var navEditId: Int? = null

    /** [sessionClear] gates the bar's ONLY clear button (VS Code parity): the STATUS BAR carries the
     *  session-wide Clear Resolved; the OVERVIEW title bar (default) carries none — its toolbar's bulk
     *  actions already include the session-wide clear. (The file-scoped Clear File was REMOVED
     *  2026-07-16 — the session-wide Clear Resolved covers it.)
     *  [showText] renders each action button's SHORT label beside its icon — BOTH hosts pass true now
     *  (user rule 2026-07-16: the icon-only status bar read as cryptic; VS Code labels both surfaces
     *  too). The four nav chevrons stay icon-only on BOTH hosts (VS Code parity — its chevrons carry
     *  no label either; they frame the labeled File/Diff counters). */
    fun buildGroup(sessionClear: Boolean = false, showText: Boolean = false) = DefaultActionGroup().apply { listOfNotNull(
        // Search leads every nav bar (user rule 2026-07-16 — same position on every surface).
        searchAction(showText),
        // Diff axis before File axis — the VS Code status-bar order.
        *diffAxis().toTypedArray(),
        *fileAxis().toTypedArray(),
        keepAction(showText), undoAction(showText), acceptFileAction(showText), rejectFileAction(showText),
        if (sessionClear) clearResolvedAction(showText) else null,
        spotlightAction(showText),
    ).forEach(::add) }

    // --- the individual actions, exposed so the Overview title bar can compose its own five-group
    //     layout (ChangeMapPanel) while the status bar keeps buildGroup's flat order — one behavior,
    //     two compositions (cross-editor parity: VS Code groups its Overview toolbar the same way). ---

    fun searchAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Search", "Search Edits", NavTint.SEARCH, ::sessionHasPending) { searchEdits() }

    /** File axis — steps across every file with pending edits; the counter opens the Edits tool window. */
    fun fileAxis(): List<AnAction> = listOf(
        iconAct("Previous changed file", NavTint.tint(AllIcons.Actions.Back, NavTint.BLUE), ::sessionHasPending) { navFile(-1) },
        textAct(::fileCounterText) { ToolWindowManager.getInstance(project).getToolWindow("Claude Observatory")?.activate(null) },
        iconAct("Next changed file", NavTint.tint(AllIcons.Actions.Forward, NavTint.BLUE), ::sessionHasPending) { navFile(1) },
    )

    /** Diff axis — steps the OPEN file's pending edits; the counter opens the current edit's diff. */
    fun diffAxis(): List<AnAction> = listOf(
        iconAct("Previous edit in this file", NavTint.tint(AllIcons.Actions.PreviousOccurence, NavTint.BLUE), ::activeHasPending) { navDiff(-1) },
        textAct(::diffCounterText) { currentNavRec()?.let { rec -> session()?.let { Diffs.show(project, it, rec) } } },
        iconAct("Next edit in this file", NavTint.tint(AllIcons.Actions.NextOccurence, NavTint.BLUE), ::activeHasPending) { navDiff(1) },
    )

    fun keepAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Keep", "Keep This Edit", NavTint.KEEP, ::activeHasPending) {
            currentNavRec()?.let { rec -> withSession { s -> ReviewOps.keep(project, s, rec.id) } }
        }

    fun undoAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Undo", "Undo This Edit", NavTint.UNDO, ::activeHasPending) {
            currentNavRec()?.let { rec -> withSession { s -> ReviewOps.undoOrRedo(project, s, rec, redo = false) } }
        }

    fun acceptFileAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Accept File", "Accept every pending edit in this file", NavTint.ACCEPT_FILE, ::activeHasPending) {
            activeFilePath()?.let { f -> withSession { s -> ReviewOps.keepAll(project, s, service.log().filter { it.file == f }, File(f).name) } }
        }

    fun rejectFileAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Reject File", "Reject (revert) every pending edit in this file", NavTint.REJECT, ::activeHasPending) {
            activeFilePath()?.let { f -> withSession { s -> ReviewOps.undoAll(project, s, service.log().filter { it.file == f }, File(f).name, f) } }
        }

    fun clearResolvedAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Clear Resolved", "Clear Resolved Edits", NavTint.CLEAR, ::sessionHasPending) {
            withSession { s ->
                val resolved = service.log().count { !it.pending }
                if (resolved > 0) ReviewOps.clearResolved(project, s, resolved) else ReviewOps.notify(project, "No resolved edits to clear")
            }
        }

    fun spotlightAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Spotlight", "Toggle Spotlight — dim unedited lines", NavTint.SPOTLIGHT, ::sessionHasPending) {
            InlineOverlay.getInstance(project).toggleHeatmap()
        }

    // --- nav-bar state (mirrors the VS Code helpers) ---

    private fun session(): String? = service.currentSession()
    private fun activeFilePath(): String? = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?.path
    private fun sessionHasPending(): Boolean = service.counts().pending > 0
    private fun pendingFiles(): List<String> = service.log().filter { it.pending }.map { it.file }.distinct().sorted()
    private fun pendingInActiveFile(): List<EditRecord> {
        val f = activeFilePath() ?: return emptyList()
        return service.log().filter { it.pending && it.file == f }.sortedBy { it.id }
    }
    private fun activeHasPending(): Boolean = pendingInActiveFile().isNotEmpty()

    /** The pending edit the Diff axis is parked on, anchoring navEditId to a still-pending edit. */
    private fun currentNavRec(): EditRecord? {
        val list = pendingInActiveFile()
        if (list.isEmpty()) return null
        if (list.none { it.id == navEditId }) navEditId = list.first().id
        return list.find { it.id == navEditId }
    }

    /** Diff-axis counter text ("Diff n/m"), or null when the open file has nothing to review (hides it). */
    private fun diffCounterText(): String? {
        val list = pendingInActiveFile()
        if (list.isEmpty()) return null
        if (list.none { it.id == navEditId }) navEditId = list.first().id
        val idx = list.indexOfFirst { it.id == navEditId }
        return "Diff ${idx + 1}/${list.size}"
    }

    /** File-axis counter text ("File n/m"), or null when nothing is pending (hides it). */
    private fun fileCounterText(): String? {
        val files = pendingFiles()
        if (files.isEmpty()) return null
        val idx = activeFilePath()?.let { files.indexOf(it) } ?: -1
        return "File ${if (idx >= 0) idx + 1 else "–"}/${files.size}"
    }

    private fun navDiff(dir: Int) {
        val list = pendingInActiveFile()
        if (list.isEmpty()) return
        val idx = list.indexOfFirst { it.id == navEditId }.let { if (it < 0) 0 else it }
        val target = list[(idx + dir + list.size) % list.size]
        navEditId = target.id
        session()?.let { Navigate.openFileAtEdit(project, it, target) }
        onNavChange()
    }

    private fun navFile(dir: Int) {
        val files = pendingFiles()
        if (files.isEmpty()) return
        val idx = activeFilePath()?.let { files.indexOf(it) } ?: -1
        val target = files[((if (idx < 0) 0 else idx) + dir + files.size) % files.size]
        val first = service.log().filter { it.pending && it.file == target }.minByOrNull { it.id } ?: return
        navEditId = first.id
        session()?.let { Navigate.openFileAtEdit(project, it, first) }
        onNavChange()
    }

    private fun searchEdits() {
        val q = Messages.showInputDialog(
            project, "Filter edits by file path (empty to clear):", "Search Edits",
            null, service.filterQuery, null,
        )
        if (q != null) service.setFilter(q)
    }

    private fun withSession(block: (String) -> Unit) {
        val s = service.currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        block(s)
    }

    /** An icon toolbar button, shown only when [visible] (drives the two tiers). */
    private fun iconAct(text: String, icon: Icon, visible: () -> Boolean, run: () -> Unit): AnAction =
        object : AnAction(text, text, icon), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT // reads the active editor
            override fun update(e: AnActionEvent) { e.presentation.isVisible = visible() }
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** Like [iconAct], but when [showText] the SHORT [text] also renders beside the icon (the Overview
     *  title bar — VS Code labels these buttons); the long [description] is the tooltip on both hosts. */
    private fun labelAct(showText: Boolean, text: String, description: String, icon: Icon, visible: () -> Boolean, run: () -> Unit): AnAction =
        object : AnAction(text, description, icon), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT // reads the active editor
            @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the short label
            override fun displayTextInToolbar() = showText
            override fun update(e: AnActionEvent) { e.presentation.isVisible = visible() }
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** A text toolbar button (the Diff/File counter); hidden when [dynamicText] returns null. */
    private fun textAct(dynamicText: () -> String?, run: () -> Unit): AnAction =
        object : AnAction(), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT // reads the active editor
            @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the counter text
            override fun displayTextInToolbar() = true // force the counter text to render in the toolbar
            override fun update(e: AnActionEvent) {
                val t = dynamicText()
                e.presentation.isVisible = t != null
                e.presentation.text = t ?: ""
            }
            override fun actionPerformed(e: AnActionEvent) = run()
        }
}
