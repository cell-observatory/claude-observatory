package com.cellobservatory.observatory.services

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.SessionResolver
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.core.StoreWatcher
import com.cellobservatory.observatory.core.TranscriptWatcher
import com.cellobservatory.observatory.model.ChangeMap
import com.cellobservatory.observatory.model.ChangeMapParser
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.EditTree
import com.cellobservatory.observatory.model.MultitaskParser
import com.cellobservatory.observatory.model.MultitaskResult
import com.cellobservatory.observatory.model.Observations
import com.cellobservatory.observatory.model.ObservationsParser
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
        // Store watcher only fires on EDITS; the transcript watcher fires on transcript growth (reads,
        // bash, subagent spawns, to-dos) so Actions/Observations/Timeline/Overview/Multitasking stay live.
        TranscriptWatcher.getInstance(project).addListener(watchListener)
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

    @Volatile private var pendingByFile: Map<String, Int> = emptyMap()

    /** Folded log for the current session, cached on the log file's (mtime,size). */
    fun log(): List<EditRecord> {
        val session = currentSession() ?: run { pendingByFile = emptyMap(); return emptyList() }
        val key = "$session:${StoreReader.logKey(session)}"
        if (key != cachedKey) {
            cachedLog = StoreReader.readLog(session)
            pendingByFile = cachedLog.filter { it.pending }.groupingBy { it.file }.eachCount() // for the Project-view decorator
            cachedKey = key
        }
        return cachedLog
    }

    /** Pending-edit count for a file path — O(1), cached with the log (drives the Project-view badge). */
    fun pendingCount(path: String): Int {
        log() // ensure the cache is current
        return pendingByFile[path] ?: 0
    }

    // Review-loop cursor: id of the pending edit last opened, so repeated ←/→ invocations step
    // backward/forward through every pending edit (wrapping at the ends). Shared by the toolbar
    // buttons, the ⌥⌘N/⌥⌘P actions, the status-bar cluster, and the editor banner.
    @Volatile private var reviewCursorId: Int? = null

    /** The pending edit the review cursor is parked on (null when unset or no longer pending) —
     *  the anchor for the editor banner's per-edit Keep/Undo. */
    fun currentPendingEdit(): EditRecord? = reviewCursorId?.let { id -> log().find { it.id == id && it.pending } }

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

    // --- Shared throttled CLI views (0.8.0 stabilization) -------------------------------------------
    // One refresh() cycle used to spawn ~4 CLI processes (ChangeMapPanel: multitask + changemap;
    // ActionsPanel: multitask again; ObservationsPanel: observations) as often as every ~2s during
    // active work. Each view below is fetched at most once per MIN_FETCH_MS, shared by every panel
    // (multitask now spawns once per window, not twice), and fanned out via the listener ring when it
    // lands — VS Code parity: its Overview webview self-throttles its spawns at 3s.

    private inner class ThrottledFetch<T : Any>(private val fetch: (String) -> T?) {
        @Volatile var value: T? = null
            private set
        @Volatile private var fetchedKey = ""
        @Volatile private var fetchedAt = 0L
        @Volatile private var inFlight = false

        /** Latest cached view (possibly null before the first fetch lands); kicks a background refresh
         *  when stale. `force` bypasses the throttle (the toolbar Refresh button). */
        fun get(key: String, force: Boolean = false): T? {
            val now = System.currentTimeMillis()
            val stale = key != fetchedKey || now - fetchedAt >= MIN_FETCH_MS
            if (!inFlight && (stale || force)) {
                inFlight = true
                ApplicationManager.getApplication().executeOnPooledThread {
                    try {
                        val v = fetch(key)
                        fetchedAt = System.currentTimeMillis() // set on failure too — back off, don't spin
                        if (v != null) {
                            value = v
                            fetchedKey = key
                            ApplicationManager.getApplication().invokeLater { listeners.forEach { it.run() } }
                        }
                    } finally {
                        inFlight = false
                    }
                }
            }
            return value
        }
    }

    private val multitaskFetch = ThrottledFetch { _ ->
        ObservatoryCli.multitaskJson(workspaceRoot)?.let { MultitaskParser.parse(it) }
    }
    private val changemapFetch = ThrottledFetch { session ->
        ObservatoryCli.changemapJson(session, workspaceRoot)?.let { ChangeMapParser.parse(it) }
    }
    private val observationsFetch = ThrottledFetch { session ->
        ObservatoryCli.observationsJson(session, workspaceRoot)?.let { ObservationsParser.parse(it) }
    }

    /** The shared `multitask --json` view (fleet + workflows + curated actions). Keyed on the active
     *  session so a session switch refetches immediately. */
    fun multitask(force: Boolean = false): MultitaskResult? = multitaskFetch.get(currentSession() ?: "", force)

    /** The shared `changemap --json` view (the Overview detail). */
    fun changemap(force: Boolean = false): ChangeMap? = currentSession()?.let { changemapFetch.get(it, force) }

    /** The shared `observations --json` view-model. */
    fun observations(force: Boolean = false): Observations? = currentSession()?.let { observationsFetch.get(it, force) }

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
        TranscriptWatcher.getInstance(project).removeListener(watchListener)
    }

    companion object {
        fun getInstance(project: Project): ObservatoryService = project.getService(ObservatoryService::class.java)

        /** Minimum interval between spawns of the same CLI view (matches VS Code's Overview throttle). */
        private const val MIN_FETCH_MS = 3_000L
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
                // Re-run the Project-view decorator (pending-edit badges) on each store change; keep the
                // tree expansion so it never collapses under the user.
                svc.addListener {
                    if (!project.isDisposed) {
                        com.intellij.ide.projectView.ProjectView.getInstance(project).currentProjectViewPane?.updateFromRoot(true)
                    }
                }
            }
        }
    }
}
