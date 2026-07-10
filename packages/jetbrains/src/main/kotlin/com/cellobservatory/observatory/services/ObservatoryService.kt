package com.cellobservatory.observatory.services

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.SessionResolver
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.core.StoreWatcher
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.EditTree
import com.cellobservatory.observatory.model.TreeParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Project-level hub: resolves the active session for this project's root, caches the folded log
 * on the (mtime,size) key, and fans out refresh events (store watcher → trees, status bar, …).
 */
@Service(Service.Level.PROJECT)
class ObservatoryService(private val project: Project) : Disposable {
    private val listeners = CopyOnWriteArrayList<Runnable>()
    private var cachedLog: List<EditRecord> = emptyList()
    private var cachedKey: String = ""
    @Volatile private var cachedAutoSession: String? = null
    @Volatile private var cachedAutoRoot: String? = null
    private val watchListener = Runnable { refresh() }

    init {
        StoreWatcher.instance.addListener(watchListener)
    }

    val workspaceRoot: String? get() = project.basePath

    fun currentSession(): String? {
        // A pinned session (Switch Session / settings) wins over auto-resolution — lets you review the
        // demo-showcase fixture or any past session instead of just the newest for this workspace.
        com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.session
            ?.takeIf { it.isNotBlank() }
            ?.let { return it }
        val root = workspaceRoot ?: return null
        // Memoize the auto-resolution (invalidated on refresh()): resolveSessionId walks parent dirs
        // listing *.jsonl, and currentSession() is hit per cell renderer + per log()/counts()/tree call.
        cachedAutoSession?.let { if (cachedAutoRoot == root) return it }
        return SessionResolver.resolveSessionId(root).also {
            cachedAutoSession = it
            cachedAutoRoot = root
        }
    }

    /** Folded log for the current session, cached on the log file's (mtime,size). */
    fun log(): List<EditRecord> {
        val session = currentSession() ?: return emptyList()
        val key = "$session:${StoreReader.logKey(session)}"
        if (key != cachedKey) {
            cachedLog = StoreReader.readLog(session)
            cachedKey = key
        }
        return cachedLog
    }

    // Review-loop cursor: id of the pending edit last opened, so repeated ←/→ invocations step
    // backward/forward through every pending edit (wrapping at the ends). Shared by the toolbar
    // buttons, the ⌥⌘N/⌥⌘P actions, the status-bar cluster, and the editor banner.
    @Volatile private var reviewCursorId: Int? = null

    /** Next pending edit in the review loop, advancing the cursor. Returns null when none are pending. */
    fun nextPendingEdit(): EditRecord? = stepPendingEdit(1)

    /** Previous pending edit in the review loop, retreating the cursor. Returns null when none are pending. */
    fun prevPendingEdit(): EditRecord? = stepPendingEdit(-1)

    private fun stepPendingEdit(dir: Int): EditRecord? {
        val pending = log().filter { it.pending }.sortedBy { it.id }
        if (pending.isEmpty()) {
            reviewCursorId = null
            return null
        }
        val cursor = reviewCursorId
        val idx = if (cursor == null) -1 else pending.indexOfFirst { it.id == cursor }
        val next = when {
            idx >= 0 -> pending[(idx + dir + pending.size) % pending.size]     // step ±1, wrapping at the ends
            cursor == null -> if (dir > 0) pending.first() else pending.last()  // first review: oldest (→) / newest (←)
            dir > 0 -> pending.firstOrNull { it.id > cursor } ?: pending.first() // resolved — resume just past it
            else -> pending.lastOrNull { it.id < cursor } ?: pending.last()
        }
        reviewCursorId = next.id
        return next
    }

    // Active "Search edits" filter — shared across the Edits and Diffs trees so they filter together
    // (parity with the VS Code module-level filter). Matches on workspace-relative path.
    @Volatile var filterQuery: String = ""
        private set

    /** Set the Search filter and re-render every surface. Empty/blank clears it. */
    fun setFilter(query: String) {
        filterQuery = query.trim()
        refresh()
    }

    // Edit-tree view-model from the CLI `tree --json` (the single source; VS Code renders the same
    // core.buildEditTree). Folder compaction, class grouping, exact deltas, and Search filtering all
    // happen server-side. Fetched in the background, cached on session+filter+log key; primes itself
    // on first read and repaints when it lands.
    @Volatile private var editTreeCache: EditTree? = null
    @Volatile private var editTreeKey: String = ""

    fun editTree(): EditTree? {
        refreshEditTree()
        return editTreeCache
    }

    private fun refreshEditTree() {
        val session = currentSession() ?: run { editTreeCache = null; return }
        val key = "$session|$filterQuery|${StoreReader.logKey(session)}"
        if (key == editTreeKey) return
        editTreeKey = key // claim this fetch so rapid refreshes don't stack
        ApplicationManager.getApplication().executeOnPooledThread {
            val parsed = ObservatoryCli.treeJson(session, workspaceRoot, filterQuery)?.let { TreeParser.parse(it) }
            if (parsed == null) {
                editTreeKey = "" // fetch failed — retry on the next refresh
            } else {
                editTreeCache = parsed
                ApplicationManager.getApplication().invokeLater { listeners.forEach { it.run() } }
            }
        }
    }

    data class Counts(val pending: Int, val kept: Int, val undone: Int, val oldestPendingTs: Long?)

    fun counts(): Counts {
        val log = log()
        return Counts(
            pending = log.count { it.pending },
            kept = log.count { it.kept },
            undone = log.count { it.undone },
            oldestPendingTs = log.filter { it.pending }.minOfOrNull { it.ts },
        )
    }

    fun addListener(l: Runnable) = listeners.add(l)
    fun removeListener(l: Runnable) = listeners.remove(l)

    /** Invalidate caches and re-render every registered surface. Call on the EDT. */
    fun refresh() {
        cachedKey = "" // force re-read
        cachedAutoSession = null // re-resolve the session (a new session may have appeared)
        refreshEditTree() // kick a background tree fetch; repaints when it lands
        listeners.forEach { it.run() }
    }

    override fun dispose() {
        StoreWatcher.instance.removeListener(watchListener)
    }

    companion object {
        fun getInstance(project: Project): ObservatoryService = project.getService(ObservatoryService::class.java)
    }
}

/** Startup: arm the watcher and the inline overlay even before the tool window is first opened. */
class ObservatoryStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        ObservatoryService.getInstance(project)
        com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
            if (!project.isDisposed) {
                com.cellobservatory.observatory.ui.inline.InlineOverlay.getInstance(project).install()
                val svc = ObservatoryService.getInstance(project)
                // Keep the editor-top review banner live: re-run the notification provider on every store change.
                val notifications = com.intellij.ui.EditorNotifications.getInstance(project)
                svc.addListener { notifications.updateAllNotifications() }
                // Tool-window stripe badge: overlay a dot while edits are pending (parity with VS Code's title count).
                val updateBadge = Runnable {
                    com.intellij.openapi.wm.ToolWindowManager.getInstance(project)
                        .getToolWindow("Claude Observatory")
                        ?.setIcon(com.cellobservatory.observatory.ui.Icons.toolWindowIcon(svc.counts().pending))
                }
                svc.addListener(updateBadge)
                updateBadge.run()
            }
        }
    }
}
