package com.cellobservatory.observatory.services

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.SessionResolver
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.core.StoreWatcher
import com.cellobservatory.observatory.core.TranscriptWatcher
import com.cellobservatory.observatory.model.AuditParser
import com.cellobservatory.observatory.model.ChangeMap
import com.cellobservatory.observatory.model.ChangeMapParser
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.EditTree
import com.cellobservatory.observatory.model.Feed
import com.cellobservatory.observatory.model.FeedParser
import com.cellobservatory.observatory.model.MultitaskParser
import com.cellobservatory.observatory.model.MultitaskResult
import com.cellobservatory.observatory.model.Observations
import com.cellobservatory.observatory.model.ObservationsParser
import com.cellobservatory.observatory.model.ProcessesParser
import com.cellobservatory.observatory.model.ProcessesResult
import com.cellobservatory.observatory.model.PromptsParser
import com.cellobservatory.observatory.model.PromptsResult
import com.cellobservatory.observatory.model.SessionAudit
import com.cellobservatory.observatory.model.SessionsParser
import com.cellobservatory.observatory.model.SessionsResult
import com.cellobservatory.observatory.model.TreeParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.util.concurrency.EdtScheduledExecutorService
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Project-level hub: resolves the active session for this project's root, caches the folded log
 * on the (mtime,size) key, and fans out refresh events (store watcher → trees, status bar, …).
 */
@Service(Service.Level.PROJECT)
class ObservatoryService(private val project: Project) : Disposable {
    private val listeners = CopyOnWriteArrayList<Runnable>()
    // @Volatile because this pair is now read from BACKGROUND threads: ~20 toolbar actions moved to
    // ActionUpdateThread.BGT in 0.8.9 and every one of them calls log()/counts(). Two threads could
    // otherwise interleave the value/key writes and leave one session's log labelled with another
    // session's key, which then sticks until the key moves again.
    @Volatile private var cachedLog: List<EditRecord> = emptyList()
    @Volatile private var cachedKey: String = ""
    @Volatile private var cachedAutoSession: String? = null
    @Volatile private var cachedAutoRoot: String? = null
    private val watchListener = Runnable { refresh() }

    /** True while a coalesced repaint is queued on the EDT — see [notifyListeners]. */
    private val repaintQueued = AtomicBoolean(false)

    init {
        StoreWatcher.instance.addListener(watchListener)
        // Store watcher only fires on EDITS; the transcript watcher fires on transcript growth (reads,
        // bash, subagent spawns, to-dos) so Actions/Observations/Timeline/Overview/Multitasking stay live.
        TranscriptWatcher.getInstance(project).addListener(watchListener)
    }

    val workspaceRoot: String? get() = project.basePath

    /**
     * Demo mode's session, held in MEMORY and deliberately never written to settings. Persisting it
     * would leave a pin behind after a crash pointing at a session demo cleanup has since deleted,
     * which shows as every panel being permanently empty for a non-obvious reason. Auto-resolution
     * already lands on a running demo unaided (its transcript is the newest); this is the guard against
     * a real Claude session starting mid-tour.
     */
    @Volatile
    var demoSessionOverride: String? = null
        set(value) {
            field = value
            cachedAutoSession = null // the auto-resolution memo must not answer for the old session
            cachedAutoRoot = null
            refresh(force = true)
        }

    fun currentSession(): String? {
        demoSessionOverride?.takeIf { it.isNotBlank() }?.let { return it }
        // A pinned session (Switch Session / settings) wins over auto-resolution — lets you review a
        // demo session or any past session instead of just the newest for this workspace.
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
            // Ignore a result the key has already moved past: a mutation re-keys mid-flight and starts a
            // second fetch, and the two land in whatever order the CLI finishes them — an older answer
            // winning would park a pre-mutation tree in the cache that nothing would refetch.
            if (editTreeKey != key) return@executeOnPooledThread
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
        /** True once a fetch has COMPLETED at least once, successfully or not. A null [value] means two
         *  very different things — "not asked yet" and "asked, and the CLI could not answer" — and a
         *  panel that blurs them states as fact something it never observed. */
        @Volatile var attempted = false
            private set
        @Volatile private var fetchedKey = ""
        @Volatile private var fetchedAt = 0L
        @Volatile private var inFlight = false
        /** Consecutive failures, for the back-off below. Reset the moment one succeeds. */
        @Volatile private var misses = 0

        /** A refresh that must NOT be dropped — armed by the Refresh button and by [refresh]`(force=true)`
         *  after a MUTATION. It outlives an in-flight spawn on purpose: see [spawn]. */
        @Volatile private var forced = false

        /** Arm a forced refresh without asking for the value (the mutation path — the panel's next
         *  [get] on the same tick then spawns even if the throttle window has not elapsed). */
        fun forceNext() {
            forced = true
        }

        /** Latest cached view (possibly null before the first fetch lands); kicks a background refresh
         *  when stale. `force` bypasses the throttle (the toolbar Refresh button). */
        fun get(key: String, force: Boolean = false): T? {
            if (force) forced = true
            val now = System.currentTimeMillis()
            // Back off after failures instead of re-asking every three seconds forever. A view that
            // cannot answer usually cannot answer for a reason that will still be true in three seconds
            // (an unbuildable session, a CLI that is not there), and retrying at full cadence turns one
            // broken view into a permanently busy core. Doubles to a minute, and any success clears it.
            val wait = if (misses == 0) MIN_FETCH_MS else minOf(MIN_FETCH_MS shl minOf(misses, 5), 60_000L)
            val stale = key != fetchedKey || now - fetchedAt >= wait
            if (!inFlight && (stale || forced)) spawn(key)
            return value
        }

        private fun spawn(key: String) {
            inFlight = true
            forced = false // this spawn answers the pending force…
            ApplicationManager.getApplication().executeOnPooledThread {
                try {
                    val v = fetch(key)
                    fetchedAt = System.currentTimeMillis() // set on failure too — back off, don't spin
                    if (v != null) {
                        misses = 0
                        value = v
                        fetchedKey = key
                        notifyListeners()
                    } else {
                        misses++
                    }
                } finally {
                    attempted = true
                    inFlight = false
                    // …but a force that arrived WHILE this ran asked about a state this spawn could not
                    // have seen — it started BEFORE the mutation. Dropping it (the old `!inFlight` guard
                    // did) let the stale answer stand, which is how the panel kept showing pre-mutation
                    // pending/accepted counts after Clear Resolved. Re-run instead.
                    if (forced) ApplicationManager.getApplication().invokeLater { get(key) }
                }
            }
        }
    }

    // Keyed on the ACTIVE session and pinned with it: `multitask --json` decides its `self` fleet row and
    // its session-scoped sections (actions, tasks) from --session, so a pinned session must be passed or
    // every one of those keeps describing whatever the CLI resolves as newest for the cwd.
    private val multitaskFetch = ThrottledFetch { session ->
        ObservatoryCli.multitaskJson(session.takeIf { it.isNotBlank() }, workspaceRoot)?.let { MultitaskParser.parse(it) }
    }
    private val changemapFetch = ThrottledFetch { session ->
        ObservatoryCli.changemapJson(session, workspaceRoot)?.let { ChangeMapParser.parse(it) }
    }
    private val observationsFetch = ThrottledFetch { session ->
        ObservatoryCli.observationsJson(session, workspaceRoot)?.let { ObservationsParser.parse(it) }
    }
    private val processesFetch = ThrottledFetch { session ->
        ObservatoryCli.processesJson(session, workspaceRoot)?.let { ProcessesParser.parse(it) }
    }
    // The user's own turns (0.8.7) — the Overview's first nav tab AND the Prompt review axis. Rides the
    // same throttled tick as every other view; never a timer of its own.
    private val promptsFetch = ThrottledFetch { session ->
        ObservatoryCli.promptsJson(session, workspaceRoot)?.let { PromptsParser.parse(it) }
    }
    // Every session in this workspace, newest CONVERSATION first (0.8.8) — the Overview's Sessions tab
    // and the Switch Session popup read the same rows. Cheap by construction in core (stats + a bounded,
    // sidecar-cached title scan; no store log is parsed), so it rides the shared tick like any other view.
    private val sessionsFetch = ThrottledFetch { _ ->
        ObservatoryCli.sessionsJson(workspaceRoot, currentSession(), buildBatch = true)?.let { SessionsParser.parse(it) }
    }
    // The folded footprint's two surviving facts (0.8.7): the writes that left the workspace (`risk`) and
    // the reads that did (`egress`'s `file` channels). Neither rides the shared multitask payload, so both
    // are fetched here — in ONE throttled slot, on the panel's existing refresh tick, never a new timer.
    private val auditFetch = ThrottledFetch { session ->
        val risk = ObservatoryCli.riskJson(session, workspaceRoot)
        val egress = ObservatoryCli.egressJson(session, workspaceRoot)
        if (risk == null || egress == null) null else AuditParser.parse(risk, egress)
    }

    /** Which feed to tail. Carries the SESSION as well as core's ref, because a fleet row can name a
     *  sibling session rather than this project's active one. */
    data class FeedRef(val session: String, val kind: String, val id: String) {
        internal val key: String get() = listOf(session, kind, id).joinToString(KEY_SEP)
    }

    /** One shared slot serves every feed, so the cached tail carries the ref it was fetched FOR — a tail
     *  that landed for a previous selection must never be handed back under the new one. */
    private val feedFetch = ThrottledFetch { key ->
        val p = key.split(KEY_SEP)
        ObservatoryCli.feedJson(p[0], p[1], p[2], FEED_LIMIT, workspaceRoot)
            ?.let { FeedParser.parse(it) }
            ?.let { key to it }
    }

    /** The shared `multitask --json` view (fleet + workflows + curated actions). Keyed on the active
     *  session so a session switch refetches immediately. */
    fun multitask(force: Boolean = false): MultitaskResult? = multitaskFetch.get(currentSession() ?: "", force)

    /** The shared `changemap --json` view (the Overview detail). */
    fun changemap(force: Boolean = false): ChangeMap? = currentSession()?.let { changemapFetch.get(it, force) }

    /** The shared `observations --json` view-model. */
    fun observations(force: Boolean = false): Observations? = currentSession()?.let { observationsFetch.get(it, force) }

    /** The shared `risk` + `egress` audit view — the Actions surface's out-of-workspace writes and its
     *  full destination list (incl. the `file` reads that left the workspace). */
    fun audit(force: Boolean = false): SessionAudit? = currentSession()?.let { auditFetch.get(it, force) }

    /** The shared `processes --json` view (the Overview's Processes tab). */
    fun processes(force: Boolean = false): ProcessesResult? = currentSession()?.let { processesFetch.get(it, force) }

    /** True once a `processes --json` fetch has completed — with [processes] null, this separates "still
     *  reading" from "this CLI cannot answer for background shells" (an older one on PATH). */
    val processesAttempted: Boolean get() = processesFetch.attempted

    /** The shared `prompts --json` view (the Overview's Prompts tab + the Prompt review axis). */
    fun prompts(force: Boolean = false): PromptsResult? = currentSession()?.let { promptsFetch.get(it, force) }

    /** The shared `sessions --json` view (the Overview's Sessions tab). Keyed on the active session so
     *  switching re-marks which row is live. */
    fun sessions(force: Boolean = false): SessionsResult? = sessionsFetch.get(currentSession() ?: "", force)

    /** True once a `sessions --json` fetch has completed — with [sessions] null, this separates "still
     *  reading" from "this CLI cannot answer for sessions" (an older one on PATH). */
    val sessionsAttempted: Boolean get() = sessionsFetch.attempted

    /** True once a `prompts --json` fetch has completed — with [prompts] null, this separates "still
     *  reading" from "this CLI cannot answer for prompts" (an older one on PATH). */
    val promptsAttempted: Boolean get() = promptsFetch.attempted

    /**
     * The ask picked in the Prompts window — the SCOPE every other dashboard narrows to (0.8.7).
     *
     * It lives on the service rather than in either panel because two windows have to agree about it:
     * the Prompts window owns the pick, the Overview filters its fleet · runs · tasks · shells and its
     * whole change map by it, and either one can clear it. Setting it re-renders every registered
     * surface through the existing listener path — no new channel, no new timer.
     */
    var selectedPromptId: String? = null
        set(value) {
            if (field == value) return
            field = value
            notifyListeners()
        }

    /**
     * The `feed --json` tail for [ref], on the same throttled path as every other view — the panel gets
     * its feed on its existing refresh tick, no extra timer.
     *
     * An 'audit' feed is a RECORD of something that already finished, so it is fetched once and then
     * left alone: re-polling a completed run would spend a CLI spawn per tick to re-read a file that
     * can no longer change. `force` (the Refresh button) still refetches.
     */
    fun feed(ref: FeedRef, force: Boolean = false): Feed? {
        val loaded = feedFetch.value?.takeIf { it.first == ref.key }?.second
        if (!force && loaded != null && !loaded.live) return loaded
        return feedFetch.get(ref.key, force)?.takeIf { it.first == ref.key }?.second
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

    /**
     * Invalidate caches and re-render every registered surface. Call on the EDT.
     *
     * [force] is for MUTATIONS (keep/undo/redo/clear): their refresh must never be swallowed by the
     * throttle, and must never be answered by a spawn that started BEFORE the mutation — either one
     * leaves the panel stating pre-mutation counts as current fact. Watcher-driven refreshes stay
     * throttled: they fire on every transcript byte.
     */
    fun refresh(force: Boolean = false) {
        cachedKey = "" // force re-read
        cachedAutoSession = null // re-resolve the session (a new session may have appeared)
        if (force) {
            // A forced refresh follows a MUTATION. The batched views are cached for ~2.5 s, so without
            // this the Overview would repaint with pre-mutation counts while the Edits tree — which reads
            // the store directly — already showed the new ones: the two panels disagreeing on screen.
            ObservatoryCli.invalidateViewBatch()
            sharedViews.forEach { it.forceNext() }
        }
        refreshEditTree() // kick a background tree fetch; repaints when it lands
        notifyListeners()
        warmRecentSessions()
    }

    /** When this project last pre-built its recent sessions, so an idle IDE does not loop on it. */
    @Volatile private var warmedAt = 0L

    /**
     * Spend idle time pre-building the sessions you are likely to switch to (0.9.0).
     *
     * Detached and rate-limited to once every ten minutes: the point is to remove the 6.2 s a cold switch
     * used to cost, not to add a background job that competes with the refresh that just ran.
     */
    private fun warmRecentSessions() {
        val now = System.currentTimeMillis()
        if (now - warmedAt < 10 * 60_000L) return
        warmedAt = now
        ApplicationManager.getApplication().executeOnPooledThread { ObservatoryCli.warmRecent(project.basePath) }
    }

    /**
     * Fan a repaint out to every registered surface, coalescing bursts (0.8.8).
     *
     * Eight throttled CLI views land within milliseconds of each other on a single refresh tick, and each
     * landing used to rebuild all six registered panels synchronously — dozens of full Swing rebuilds per
     * tick, every one of them discarded by the next. The first notification now schedules one repaint on
     * the EDT and every notification arriving before it runs folds into that repaint; the delay is far
     * below the threshold where a repaint reads as delayed, and no notification is ever dropped.
     */
    private fun notifyListeners() {
        if (!repaintQueued.compareAndSet(false, true)) return
        EdtScheduledExecutorService.getInstance().schedule({
            repaintQueued.set(false)
            if (!project.isDisposed) listeners.forEach { it.run() }
        }, NOTIFY_COALESCE_MS, TimeUnit.MILLISECONDS)
    }

    /** Every shared throttled view, so a forced refresh reaches all of them (feeds included — a reverted
     *  edit changes what the selected row's window shows). */
    private val sharedViews: List<ThrottledFetch<*>>
        get() = listOf(
            multitaskFetch, changemapFetch, observationsFetch, processesFetch,
            promptsFetch, sessionsFetch, auditFetch, feedFetch,
        )

    override fun dispose() {
        StoreWatcher.instance.removeListener(watchListener)
        TranscriptWatcher.getInstance(project).removeListener(watchListener)
    }

    companion object {
        fun getInstance(project: Project): ObservatoryService = project.getService(ObservatoryService::class.java)

        /** Minimum interval between spawns of the same CLI view (matches VS Code's Overview throttle). */
        private const val MIN_FETCH_MS = 3_000L

        /** Window over which listener notifications collapse into one repaint (see [notifyListeners]). */
        private const val NOTIFY_COALESCE_MS = 90L

        /** Feed rows per fetch — enough scrollback to be useful, bounded so a busy agent's tail stays
         *  cheap to post on every tick. Anything older comes back as the feed's `truncated` count. */
        private const val FEED_LIMIT = 80

        /** Field separator for the feed's composite cache key (session · kind · id) — a control char, so
         *  no id can ever split into the wrong fields. */
        private const val KEY_SEP = "\u0000"
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
                offerDemo(project)
            }
        }
    }

    /**
     * Offer the demo on a first install and after an update, once, with a way to decline for good.
     *
     * Every gate matters, and the last one most: an unsolicited notification that interrupts a live
     * Claude session is worse than never offering, so a busy project is skipped WITHOUT stamping the
     * version — it is offered next launch, when the reader is idle.
     */
    private fun offerDemo(project: Project) {
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        if (app.isUnitTestMode || app.isHeadlessEnvironment) return
        // The demo WRITES into the reader's project. Never offer that in a project they have not trusted
        // (VS Code gates on workspace.isTrusted for the same reason).
        if (!com.intellij.ide.trustedProjects.TrustedProjects.isProjectTrusted(project)) return
        val state = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state
        if (state.demoOfferNever) return
        val current = com.intellij.ide.plugins.PluginManagerCore
            .getPlugin(com.intellij.openapi.extensions.PluginId.getId("com.cell-observatory.claude-observatory"))
            ?.version ?: return
        if (state.demoOfferLastSeenVersion == current) return
        val root = project.basePath ?: return
        // An empty version stamp cannot tell a fresh install from an upgrade on its own.
        val kind = if (state.demoOfferLastSeenVersion != null || state.everRan) "update" else "install"

        val busy = {
            val id = ObservatoryService.getInstance(project).currentSession()
            if (id == null || com.cellobservatory.observatory.core.ObservatoryCli.isDemoSession(id)) false
            else runCatching {
                val f = java.io.File(com.cellobservatory.observatory.core.ClaudePaths.projectDir(root).toFile(), "$id.jsonl")
                f.exists() && System.currentTimeMillis() - f.lastModified() <= 5 * 60_000
            }.getOrDefault(false)
        }
        // Stamped only once we are actually going to ask. Setting it above the busy gate turned a reader's
        // FIRST EVER offer into the "is now 0.8.9" update copy: launch one stamps everRan and returns
        // without stamping the version, and launch two then computes kind == "update".
        if (busy()) return // and deliberately NOT stamped — try again next launch
        state.everRan = true

        // A balloon at t=0 on a cold IDE is hostile; startup is already doing enough.
        com.intellij.util.concurrency.EdtScheduledExecutorService.getInstance().schedule({
            if (project.isDisposed || busy()) return@schedule
            // The action below hides itself once a demo is on disk (StartDemoAction.update), so offering
            // then would show a balloon with nothing to press. Stamp and stay quiet: they have already
            // found it.
            if (com.cellobservatory.observatory.ui.ReviewOps.demoPresent(project)) {
                state.demoOfferLastSeenVersion = current
                return@schedule
            }
            state.demoOfferLastSeenVersion = current // stamp BEFORE showing: an ignored balloon never re-asks
            val text = if (kind == "install") {
                "Claude Observatory is installed. There is nothing to set up to look around: the demo replays a real Claude session through the real capture pipeline in about twenty seconds, every button in it works, and leaving removes every trace."
            } else {
                "Claude Observatory is now $current. The guided tour walks what changed alongside everything else — the demo replays in about twenty seconds and removes every trace when you leave."
            }
            com.intellij.notification.NotificationGroupManager.getInstance()
                .getNotificationGroup("Claude Observatory")
                .createNotification(text, com.intellij.notification.NotificationType.INFORMATION)
                // startDemo replays AND then tours: there is no demo yet, so the tour alone would walk
                // the reader through an empty product.
                .addAction(com.intellij.notification.NotificationAction.createSimpleExpiring("Take the tour") {
                    com.cellobservatory.observatory.ui.ReviewOps.startDemo(project)
                })
                .addAction(com.intellij.notification.NotificationAction.createSimpleExpiring("Never ask") {
                    com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.demoOfferNever = true
                })
                .notify(project)
        }, 4, java.util.concurrent.TimeUnit.SECONDS)
    }
}
