package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ChatRef
import com.cellobservatory.observatory.model.ChangeMapChapter
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.SessionRequest
import com.cellobservatory.observatory.model.folderLabelOf
import com.cellobservatory.observatory.model.relTime
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

    /** The current session's change-map chapters (with editIds) — the model the Chapter axis walks. The
     *  Overview title bar feeds it `map.chapters`; the status bar leaves it empty (it carries no Chapter
     *  axis, VS Code parity), so a null map degrades to an axis that simply hides. */
    var chaptersProvider: () -> List<ChangeMapChapter> = { emptyList() }

    /** The Overview nav bar shows the RICH Diff/File counters (the current edit's relative time · the open
     *  file's name + pending-edit count); the STATUS BAR stays terse ("Diff n/m" · "File n/m"), matching
     *  VS Code where that extra detail rides only the Overview's NAVPOS counters. The Overview host sets this. */
    var richCounters: Boolean = false

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

    /** Diff-axis Chat — hand the CURRENT edit's context to the user's Claude (mirrors the chat-context path). */
    fun chatEditAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Chat", "Chat about this edit — copies its context, opens your Claude", NavTint.CHAT, ::activeHasPending) {
            currentNavRec()?.let { rec -> withSession { s -> ReviewOps.chatAbout(project, s, rec.id) } }
        }

    /** Diff-axis View diff — open the CURRENT edit as a real side-by-side diff (before ⟶ after), via Diffs.show. */
    fun viewDiffAction(showText: Boolean = true): AnAction =
        labelAct(showText, "View diff", "View this edit's diff — before / after", NavTint.tint(AllIcons.Actions.Diff, NavTint.BLUE), ::activeHasPending) {
            currentNavRec()?.let { rec -> session()?.let { Diffs.show(project, it, rec) } }
        }

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

    /** Diff-axis counter text ("Diff n/m · <relative time>"), or null when the open file has nothing to
     *  review. The current edit's relative time trails the counter (VS Code parity). */
    private fun diffCounterText(): String? {
        val list = pendingInActiveFile()
        if (list.isEmpty()) return null
        if (list.none { it.id == navEditId }) navEditId = list.first().id
        val idx = list.indexOfFirst { it.id == navEditId }
        val time = if (richCounters) list.find { it.id == navEditId }?.let { relTime(it.ts) } else null
        return "Diff ${idx + 1}/${list.size}" + (if (!time.isNullOrBlank()) " · $time" else "")
    }

    /** File-axis counter text ("File n/m · <filename> · N edits"), or null when nothing is pending. The
     *  open file's basename + its pending-edit count trail the counter (VS Code parity). */
    private fun fileCounterText(): String? {
        val files = pendingFiles()
        if (files.isEmpty()) return null
        val active = activeFilePath()
        val idx = active?.let { files.indexOf(it) } ?: -1
        val base = "File ${if (idx >= 0) idx + 1 else "–"}/${files.size}"
        if (!richCounters || idx < 0 || active == null) return base
        val edits = pendingInActiveFile().size
        return "$base · ${File(active).name}" + (if (edits > 0) " · $edits edit${if (edits == 1) "" else "s"}" else "")
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

    /** A text toolbar button (the Diff/File/Folder/Chapter counter); hidden when [dynamicText] returns
     *  null. [dynamicTip], when given, becomes the button's hover tooltip (the Chapter axis shows its
     *  title there rather than inline — VS Code parity). */
    private fun textAct(dynamicText: () -> String?, dynamicTip: (() -> String?)? = null, run: () -> Unit): AnAction =
        object : AnAction(), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT // reads the active editor
            @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the counter text
            override fun displayTextInToolbar() = true // force the counter text to render in the toolbar
            override fun update(e: AnActionEvent) {
                val t = dynamicText()
                e.presentation.isVisible = t != null
                e.presentation.text = t ?: ""
                dynamicTip?.let { e.presentation.description = it() ?: "" }
            }
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    // ============================ Folder axis (Overview only) ============================
    // Steps BETWEEN changed folders (change-map module buckets), path-sorted; acts on ONE bucket's exact
    // edits (not the recursive subtree). Mirrors VS Code's folderLabelOf / pendingFoldersOf / navFolder.

    private fun root(): String? = project.basePath
    private fun folderOf(file: String): String = folderLabelOf(file, root())
    private fun pendingFolders(): List<String> =
        service.log().filter { it.pending }.map { folderOf(it.file) }.distinct().sorted()
    private fun pendingInFolder(folder: String): List<EditRecord> =
        service.log().filter { it.pending && folderOf(it.file) == folder }.sortedBy { it.id }
    private fun currentFolder(): String? = activeFilePath()?.let { folderOf(it) }
    private fun activeInPendingFolder(): Boolean = currentFolder()?.let { pendingFolders().contains(it) } ?: false

    /** Folder axis — steps across every folder (module bucket) with pending edits; the counter reveals it. */
    fun folderAxis(): List<AnAction> = listOf(
        iconAct("Previous changed folder", NavTint.tint(AllIcons.Actions.Back, NavTint.BLUE), ::sessionHasPending) { navFolder(-1) },
        textAct(::folderCounterText) { currentFolder()?.let { revealFolder(it) } },
        iconAct("Next changed folder", NavTint.tint(AllIcons.Actions.Forward, NavTint.BLUE), ::sessionHasPending) { navFolder(1) },
    )

    fun acceptFolderAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Accept Folder", "Accept every pending edit in this folder", NavTint.ACCEPT_FILE, ::activeInPendingFolder) {
            currentFolder()?.let { f -> withSession { s -> ReviewOps.keepAll(project, s, pendingInFolder(f), f) } }
        }

    fun rejectFolderAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Reject Folder", "Reject (revert) every pending edit in this folder", NavTint.REJECT, ::activeInPendingFolder) {
            currentFolder()?.let { f -> withSession { s -> ReviewOps.undoFolder(project, s, pendingInFolder(f), f) } }
        }

    /** Folder-axis counter ("Folder i/n · <folder> · N files · N edits"), or null when nothing is pending. */
    private fun folderCounterText(): String? {
        val folders = pendingFolders()
        if (folders.isEmpty()) return null
        val cur = currentFolder()
        val idx = cur?.let { folders.indexOf(it) } ?: -1
        val base = "Folder ${if (idx >= 0) idx + 1 else "–"}/${folders.size}"
        if (idx < 0 || cur == null) return base
        val inFolder = pendingInFolder(cur)
        val files = inFolder.map { it.file }.distinct().size
        var name = cur
        if (name.length > 24) name = "…" + name.takeLast(23)
        val bits = mutableListOf<String>()
        if (files > 0) bits.add("$files file${if (files == 1) "" else "s"}")
        if (inFolder.isNotEmpty()) bits.add("${inFolder.size} edit${if (inFolder.size == 1) "" else "s"}")
        return "$base · $name" + (if (bits.isNotEmpty()) " · ${bits.joinToString(" · ")}" else "")
    }

    private fun navFolder(dir: Int) {
        val folders = pendingFolders()
        if (folders.isEmpty()) return
        val idx = currentFolder()?.let { folders.indexOf(it) } ?: -1
        val target = folders[((if (idx < 0) 0 else idx) + dir + folders.size) % folders.size]
        val first = pendingInFolder(target).firstOrNull() ?: return
        navEditId = first.id
        session()?.let { Navigate.openFileAtEdit(project, it, first) }
        onNavChange()
    }

    /** Jump the Folder axis straight to a named folder (a strip-tile click) — opens its first pending edit. */
    fun revealFolder(folder: String) {
        val first = pendingInFolder(folder).firstOrNull() ?: return
        navEditId = first.id
        session()?.let { Navigate.openFileAtEdit(project, it, first) }
        onNavChange()
    }

    // ============================ Chapter axis (Overview only) ============================
    // Steps BETWEEN the session's chapters (subtasks). The counter carries NO title inline — the title is
    // the counter's hover tooltip (the change-map bottom summary names the chapter). Mirrors VS Code's
    // pendingChapters / navChapter, driven by the change-map chapters' editIds (fed via chaptersProvider).

    /** Chapters with pending edits, in plan order (the synthetic session chapter sorts last by its index). */
    private fun pendingChapters(): List<ChangeMapChapter> {
        val pending = service.log().filter { it.pending }.map { it.id }.toHashSet()
        if (pending.isEmpty()) return emptyList()
        return chaptersProvider().filter { ch -> ch.editIds.any { it in pending } }.sortedBy { it.index }
    }
    private fun hasPendingChapters(): Boolean = pendingChapters().isNotEmpty()

    /** The pending chapter the Diff anchor (navEditId) falls in, or null (mirrors NAVPOS.chapter). */
    private fun currentChapter(): ChangeMapChapter? {
        val anchor = navEditId ?: return null
        return pendingChapters().firstOrNull { anchor in it.editIds }
    }
    private fun hasCurrentChapter(): Boolean = currentChapter() != null
    private fun canChatCurrentChapter(): Boolean = currentChapter()?.taskId != null

    /** The current chapter's id — the Overview bottom summary's chapter-axis scope (mirrors NAVPOS.chapter.id). */
    fun currentChapterId(): String? = currentChapter()?.id

    private fun chapterLabel(ch: ChangeMapChapter): String = ch.title.ifBlank { "chapter ${ch.index + 1}" }

    fun chapterAxis(): List<AnAction> = listOf(
        iconAct("Previous chapter (subtask)", NavTint.tint(AllIcons.Actions.Back, NavTint.BLUE), ::hasPendingChapters) { navChapter(-1) },
        textAct(::chapterCounterText, ::chapterCounterTip) { currentChapter()?.let { revealChapter(it.id) } },
        iconAct("Next chapter (subtask)", NavTint.tint(AllIcons.Actions.Forward, NavTint.BLUE), ::hasPendingChapters) { navChapter(1) },
    )

    fun reviewChapterAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Review", "Review this chapter — jump to its first pending edit", NavTint.tint(AllIcons.Actions.Preview, NavTint.BLUE), ::hasCurrentChapter) {
            currentChapter()?.let { revealChapter(it.id) }
        }

    fun acceptChapterAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Accept Chapter", "Accept every pending edit in this chapter", NavTint.ACCEPT_ALL, ::hasCurrentChapter) {
            currentChapter()?.let { ch -> withSession { s -> ReviewOps.keepTask(project, s, ch.id, chapterLabel(ch)) } }
        }

    fun rejectChapterAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Reject Chapter", "Reject (revert) every pending edit in this chapter", NavTint.REVERT_ALL, ::hasCurrentChapter) {
            currentChapter()?.let { ch -> withSession { s -> ReviewOps.undoTask(project, s, ch.id, chapterLabel(ch)) } }
        }

    fun chatChapterAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Chat", "Chat about this chapter — copies its context, opens your Claude", NavTint.CHAT, ::canChatCurrentChapter) {
            currentChapter()?.let { ch -> withSession { s -> ReviewOps.chatContext(project, s, ChatRef.Task(ch.id), "chapter “${chapterLabel(ch)}”") } }
        }

    /** Chapter-axis counter ("Chapter i/n · N folders · N files · N edits"), or null when no chapter is
     *  pending. NO title inline — see [chapterCounterTip]. */
    private fun chapterCounterText(): String? {
        val chaps = pendingChapters()
        if (chaps.isEmpty()) return null
        val cur = currentChapter()
        val idx = if (cur != null) chaps.indexOf(cur) else -1
        val base = "Chapter ${if (idx >= 0) idx + 1 else "–"}/${chaps.size}"
        if (cur == null) return base
        val log = service.log()
        val files = cur.editIds.mapNotNull { id -> log.find { it.id == id }?.file }
        val nFiles = files.distinct().size
        val nFolders = files.map { folderOf(it) }.distinct().size
        val bits = mutableListOf<String>()
        if (nFolders > 0) bits.add("$nFolders folder${if (nFolders == 1) "" else "s"}")
        if (nFiles > 0) bits.add("$nFiles file${if (nFiles == 1) "" else "s"}")
        if (cur.editIds.isNotEmpty()) bits.add("${cur.editIds.size} edit${if (cur.editIds.size == 1) "" else "s"}")
        return "$base" + (if (bits.isNotEmpty()) " · ${bits.joinToString(" · ")}" else "")
    }
    private fun chapterCounterTip(): String? = currentChapter()?.let { chapterLabel(it) } ?: "the current edit’s chapter"

    private fun navChapter(dir: Int) {
        val chaps = pendingChapters()
        if (chaps.isEmpty()) return
        val anchor = navEditId
        val curIdx = if (anchor != null) chaps.indexOfFirst { anchor in it.editIds } else -1
        val start = if (curIdx < 0) (if (dir == 1) -1 else 0) else curIdx
        val target = chaps[(start + dir + chaps.size) % chaps.size]
        val log = service.log()
        val firstId = target.editIds.firstOrNull { id -> log.any { it.id == id && it.pending } } ?: return
        val rec = log.find { it.id == firstId } ?: return
        navEditId = firstId
        session()?.let { Navigate.openFileAtEdit(project, it, rec) }
        onNavChange()
    }

    /** Jump the Chapter axis straight to a chapter (a ribbon-chip click) — opens its first pending edit. */
    fun revealChapter(chapterId: String) {
        val ch = chaptersProvider().firstOrNull { it.id == chapterId } ?: return
        val log = service.log()
        val firstId = ch.editIds.firstOrNull { id -> log.any { it.id == id && it.pending } } ?: return
        val rec = log.find { it.id == firstId } ?: return
        navEditId = firstId
        session()?.let { Navigate.openFileAtEdit(project, it, rec) }
        onNavChange()
    }

    // ============================ Request axis (Overview only) ============================
    // The LAST axis on the bar, and the only one that walks the session the way the PERSON experienced it:
    // one step per thing they asked for. Everything else groups work the way the agent saw it (its own
    // to-dos, its files, its subagents). Scope = the request's editIds, exactly as core attributed them —
    // by what STARTED the work, never by what happened to be running when it finished.

    /** The session's requests (with editIds) — the model this axis walks. The Overview feeds it
     *  `requests --json`; the status bar leaves it empty (it carries no Request axis, as with Chapter). */
    var requestsProvider: () -> List<SessionRequest> = { emptyList() }

    /** Requests with something still pending, in the order they were asked. */
    private fun pendingRequests(): List<SessionRequest> {
        val pending = service.log().filter { it.pending }.map { it.id }.toHashSet()
        if (pending.isEmpty()) return emptyList()
        return requestsProvider().filter { r -> r.editIds.any { it in pending } }.sortedBy { it.index }
    }
    private fun hasPendingRequests(): Boolean = pendingRequests().isNotEmpty()

    /** The pending request the Diff anchor (navEditId) falls in, or null. */
    private fun currentRequest(): SessionRequest? {
        val anchor = navEditId ?: return null
        return pendingRequests().firstOrNull { anchor in it.editIds }
    }
    private fun hasCurrentRequest(): Boolean = currentRequest() != null

    /** The current request's id — the Overview bottom summary's request-axis scope. */
    fun currentRequestId(): String? = currentRequest()?.id

    /** How a request is named in a prompt / notification: its turn number plus the ask itself, so a
     *  destructive confirmation says which ask it is about and not just a number. */
    private fun requestLabel(r: SessionRequest): String =
        "#${r.index}" + r.title.takeIf { it.isNotBlank() }?.let { " “${clipAsk(it)}”" }.orEmpty()

    private fun clipAsk(s: String): String = if (s.length <= 48) s else s.take(47) + "…"

    /** The edits this request produced that are still in the store (its review scope). */
    private fun editsOfRequest(r: SessionRequest): List<EditRecord> {
        val ids = r.editIds.toHashSet()
        return service.log().filter { it.id in ids }.sortedBy { it.id }
    }

    fun requestAxis(): List<AnAction> = listOf(
        iconAct("Previous request (what you asked for)", NavTint.tint(AllIcons.Actions.Back, NavTint.BLUE), ::hasPendingRequests) { navRequest(-1) },
        textAct(::requestCounterText, ::requestCounterTip) { currentRequest()?.let { revealRequest(it.id) } },
        iconAct("Next request (what you asked for)", NavTint.tint(AllIcons.Actions.Forward, NavTint.BLUE), ::hasPendingRequests) { navRequest(1) },
    )

    fun reviewRequestAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Review", "Review this request — jump to the first pending edit it produced", NavTint.tint(AllIcons.Actions.Preview, NavTint.BLUE), ::hasCurrentRequest) {
            currentRequest()?.let { revealRequest(it.id) }
        }

    fun acceptRequestAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Accept Request", "Accept every pending edit this request produced", NavTint.ACCEPT_ALL, ::hasCurrentRequest) {
            currentRequest()?.let { r -> withSession { s -> ReviewOps.keepAll(project, s, editsOfRequest(r), "request ${requestLabel(r)}") } }
        }

    fun revertRequestAction(showText: Boolean = true): AnAction =
        labelAct(showText, "Revert Request", "Revert every pending edit this request produced", NavTint.REVERT_ALL, ::hasCurrentRequest) {
            currentRequest()?.let { r ->
                withSession { s -> ReviewOps.undoIds(project, s, editsOfRequest(r), "request #${r.index}", "request ${requestLabel(r)}") }
            }
        }

    /** Request-axis counter ("Request i/n · N files · N edits"), or null when no request has pending work.
     *  The ask itself is the hover tooltip — a prompt is far too long to sit inline (Chapter parity). */
    private fun requestCounterText(): String? {
        val reqs = pendingRequests()
        if (reqs.isEmpty()) return null
        val cur = currentRequest()
        val idx = if (cur != null) reqs.indexOf(cur) else -1
        val base = "Request ${if (idx >= 0) idx + 1 else "–"}/${reqs.size}"
        if (cur == null) return base
        val log = service.log()
        val files = cur.editIds.mapNotNull { id -> log.find { it.id == id }?.file }
        val nFiles = files.distinct().size
        val bits = mutableListOf<String>()
        if (nFiles > 0) bits.add("$nFiles file${if (nFiles == 1) "" else "s"}")
        if (cur.editIds.isNotEmpty()) bits.add("${cur.editIds.size} edit${if (cur.editIds.size == 1) "" else "s"}")
        return base + (if (bits.isNotEmpty()) " · ${bits.joinToString(" · ")}" else "")
    }

    private fun requestCounterTip(): String? =
        currentRequest()?.let { "#${it.index}: ${clipAsk(it.text.ifBlank { it.title })}" }
            ?: "the request the current edit came from"

    private fun navRequest(dir: Int) {
        val reqs = pendingRequests()
        if (reqs.isEmpty()) return
        val anchor = navEditId
        val curIdx = if (anchor != null) reqs.indexOfFirst { anchor in it.editIds } else -1
        val start = if (curIdx < 0) (if (dir == 1) -1 else 0) else curIdx
        val target = reqs[(start + dir + reqs.size) % reqs.size]
        revealRequest(target.id)
    }

    /** Jump the Request axis straight to one request (a Requests-tab row click) — opens its first pending
     *  edit. A request with nothing pending is left alone: there is nothing to review, and moving the
     *  cursor to a resolved edit would silently change what every other axis is scoped to. */
    fun revealRequest(requestId: String) {
        val r = requestsProvider().firstOrNull { it.id == requestId } ?: return
        val log = service.log()
        val firstId = r.editIds.firstOrNull { id -> log.any { it.id == id && it.pending } } ?: return
        val rec = log.find { it.id == firstId } ?: return
        navEditId = firstId
        session()?.let { Navigate.openFileAtEdit(project, it, rec) }
        onNavChange()
    }
}
