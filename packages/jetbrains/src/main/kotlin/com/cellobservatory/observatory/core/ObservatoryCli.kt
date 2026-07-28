package com.cellobservatory.observatory.core

import com.cellobservatory.observatory.model.DemoStep
import com.cellobservatory.observatory.model.Placement
import com.cellobservatory.observatory.model.TourParser
import com.cellobservatory.observatory.model.UndoResult
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.google.gson.JsonParser
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessAdapter
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.execution.util.ExecUtil
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.SystemInfo
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Drives the `claude-observatory` CLI — the backend for every store MUTATION (keep/undo/redo) and
 * for diff-dependent reads (locate). The undo engine's correctness lives in the CLI's TS core;
 * this plugin never reimplements it. All calls are blocking — run them on a background thread.
 */
object ObservatoryCli {

    data class CliResult(val exitCode: Int, val stdout: String, val stderr: String) {
        val ok get() = exitCode == 0
    }

    /** GUI-launched IDEs and SSH-launched remote-dev backends have a stripped, non-login-shell
     *  PATH — probe the standard install dirs first (same candidate list as the VS Code extension
     *  and core's resolveClaudeBin). */
    fun resolveBin(): String {
        val home = System.getProperty("user.home")
        val candidates = listOfNotNull(
            ObservatorySettings.instance.state.observatoryBin,
            System.getenv("CLAUDE_OBSERVATORY_BIN"),
            "$home/.local/bin/claude-observatory",
            "/opt/homebrew/bin/claude-observatory",
            "/usr/local/bin/claude-observatory",
            "$home/.npm-global/bin/claude-observatory",
            "$home/.volta/bin/claude-observatory",
            nvmBin(home, "claude-observatory"),
            System.getenv("APPDATA")?.let { "$it\\npm\\claude-observatory.cmd" },
        )
        for (c in candidates) if (c.isNotBlank() && File(c).exists()) return c
        return "claude-observatory" // PATH fallback
    }

    /** nvm has no stable bin dir — globals land under ~/.nvm/versions/node/<ver>/bin. */
    private fun nvmBin(home: String, name: String): String? =
        File("$home/.nvm/versions/node").listFiles()
            ?.sortedByDescending { it.name }
            ?.map { File(it, "bin/$name") }
            ?.firstOrNull { it.exists() }
            ?.path

    private fun commandLine(args: List<String>, workDir: String?): GeneralCommandLine {
        // Windows: npm installs the CLI as a .cmd shim, which ProcessBuilder can't exec directly —
        // route through cmd.exe (which also does PATH+PATHEXT resolution for the bare fallback).
        val bin = resolveBin()
        val exec = if (SystemInfo.isWindows) listOf("cmd", "/c", bin) + args else listOf(bin) + args
        val cmd = GeneralCommandLine(exec)
            .withCharset(Charsets.UTF_8)
            .withRedirectErrorStream(false)
        workDir?.let { cmd.withWorkingDirectory(java.nio.file.Path.of(it)) }
        // Keep the CLI pointed at the same config dir the plugin reads.
        ObservatorySettings.instance.state.configDir?.takeIf { it.isNotBlank() }?.let {
            cmd.withEnvironment("CLAUDE_CONFIG_DIR", it)
        }
        return cmd
    }

    /**
     * How long a heavy read may take before we give up on it.
     *
     * The change map and the multitask view rebuild every SIBLING session in the repo — 36 of them here —
     * and a first, uncached build was measured at 33 s. The old 30 s budget killed it just before it
     * finished, so the on-disk cache it would have written never got written, and the next tick started
     * the same 33 s of work again: two node processes at a full core each, forever, and a panel that
     * never rendered. Letting the cold build finish once is what makes every later one ~0.1 s.
     */
    const val HEAVY_TIMEOUT_MS = 180_000

    /**
     * One spawn for the whole refresh tick.
     *
     * The panels ask for eight views — changemap, multitask, prompts, processes, sessions, observations,
     * risk, egress — and each used to be its own CLI process. Two costs came with that, and only the
     * first is obvious: ~70 ms of node start-up per spawn before any work at all, paid eight times; and
     * every process re-deriving the SAME transcript and log parses from cold, because core's memo dies
     * with the process that held it. Measured warm on a real store: 2.66 s across eight spawns against
     * 1.38 s for one batched call.
     *
     * The batch is a cache, not a schedule: whichever view asks first pays for it and the other seven
     * read the same result. The window is just under the panels' own 3 s throttle, so a tick shares one
     * spawn and the next tick gets fresh data. An older CLI on PATH has no `views` command; that is
     * detected once and every view falls back to spawning for itself, exactly as before.
     */
    /** Drop the batched view cache — call after a mutation, before a forced refresh. */
    fun invalidateViewBatch() = ViewBatch.invalidate()

    private object ViewBatch {
        private const val WINDOW_MS = 2_500L
        private val lock = Any()
        // One entry PER (session, workspace). This object is a singleton shared by every open project, so
        // a single slot would let two projects evict each other on every call — each view then missing,
        // spawning for itself AND re-spawning the batch: strictly worse than not batching at all.
        private val entries = LinkedHashMap<String, Pair<Long, Map<String, String?>>>()
        private const val MAX_ENTRIES = 8
        /** Per-(session, workspace) spawn locks, so one project's slow batch cannot block another's. */
        private val keyLocks = java.util.concurrent.ConcurrentHashMap<String, Any>()
        /** Set once if this CLI predates `views`; from then on every caller spawns for itself. */
        @Volatile private var unsupported = false

        /** Drop every cached batch. Called when a MUTATION lands: `ThrottledFetch.forced` exists so a
         *  refresh after Accept All / Reject All / Clear Resolved is never served stale, and a batch up to
         *  2.5 s old would have defeated exactly that — the Edits tree reads the store directly and would
         *  have disagreed with the Overview on screen for the rest of the window. */
        fun invalidate() {
            synchronized(lock) { entries.clear() }
        }

        /** ONE definition of the cache key — [peek] and [view] must agree, or a peek silently never
         *  hits and the picker pays a full spawn every time it opens. */
        private fun cacheKey(session: String?, workDir: String?) = "${session.orEmpty()}\u0000${workDir.orEmpty()}"

        /** The cached batch for [k] if it is still inside the window, else null. */
        private fun fresh(k: String): Map<String, String?>? = synchronized(lock) {
            entries[k]?.takeIf { System.currentTimeMillis() - it.first <= WINDOW_MS }?.second
        }

        /** Cache-only read: answers if the window is warm, never spawns. */
        fun peek(name: String, session: String?, workDir: String?): String? {
            if (unsupported) return null
            return fresh(cacheKey(session, workDir))?.get(name)
        }

        fun view(name: String, session: String?, workDir: String?): String? {
            if (unsupported) return null
            val k = cacheKey(session, workDir)
            fresh(k)?.let { return it[name] }

            // The spawn runs OUTSIDE the shared lock, under one private to this (session, workDir).
            // Holding the global lock across `fetch` serialized every open project behind whichever one
            // was building: at HEAVY_TIMEOUT_MS that is a 180 s stall on a second project whose own batch
            // was already cached. Per-key still coalesces the case that matters — several views of the
            // SAME session asking at once collapse to one spawn, which is the point of batching.
            val keyLock = keyLocks.computeIfAbsent(k) { Any() }
            synchronized(keyLock) {
                fresh(k)?.let { return it[name] } // another thread filled it while we waited
                val fresh = fetch(session, workDir)
                synchronized(lock) {
                    entries[k] = System.currentTimeMillis() to fresh
                    if (entries.size > MAX_ENTRIES) entries.remove(entries.keys.first())
                }
                // Distinct sessions accumulate over a long-lived IDE. Dropping the map while a lock is
                // held risks at worst a duplicate spawn for one key, never a wrong answer.
                if (keyLocks.size > 64) keyLocks.clear()
                return fresh[name]
            }
        }

        private fun fetch(session: String?, workDir: String?): Map<String, String?> {
            val args = buildList {
                add("views"); add("--json")
                session?.takeIf { it.isNotBlank() }?.let { add("--session"); add(it) }
                workDir?.let { add("--root"); add(it) }
            }
            val r = run(args, workDir, timeoutMs = HEAVY_TIMEOUT_MS)
            if (r.exitCode != 0 || r.stdout.isBlank()) {
                // Latch ONLY on the one failure that can never succeed later: a CLI too old to know the
                // command, which says so verbatim on stderr ("unknown command \"views\""). Everything
                // else here is transient — a timeout on a huge first build, a spawn that lost a race
                // with an upgrade, an OOM — and latching on those cost far more than it saved: one slow
                // tick permanently disabled batching for the rest of the IDE session, putting every
                // later tick back on eight spawns, which is the regression this batch exists to prevent.
                // Returning an empty map already makes THIS tick fall back per-view; the next tick retries.
                if (r.stderr.contains("unknown command")) unsupported = true
                return emptyMap()
            }
            return try {
                val obj = com.google.gson.JsonParser.parseString(r.stdout).asJsonObject
                obj.entrySet().associate { (k, v) -> k to if (v.isJsonNull) null else v.toString() }
            } catch (_: Exception) {
                // Unparseable stdout from a CLI that DID accept the command — a truncated pipe, or a
                // stray line from a wrapper script. Transient by the same argument; do not latch.
                emptyMap()
            }
        }
    }

    fun run(args: List<String>, workDir: String? = null, stdin: String? = null, timeoutMs: Int = 30_000): CliResult {
        val cmd = commandLine(args, workDir)
        return try {
            val out = if (stdin != null) {
                val proc = cmd.createProcess()
                proc.outputStream.use { it.write(stdin.toByteArray(Charsets.UTF_8)) }
                // Drain stdout AND stderr on separate threads with a bounded wait: reading stdout to
                // completion first can deadlock if the child fills the stderr pipe buffer, and the
                // old bare waitFor() had NO timeout — a wedged `locate` (run on every inline render)
                // would hang the pooled worker forever and silently strand inline/navigate/keep.
                val outBuf = StringBuilder()
                val errBuf = StringBuilder()
                val tOut = Thread { proc.inputStream.bufferedReader(Charsets.UTF_8).use { outBuf.append(it.readText()) } }
                val tErr = Thread { proc.errorStream.bufferedReader(Charsets.UTF_8).use { errBuf.append(it.readText()) } }
                tOut.start(); tErr.start()
                if (proc.waitFor(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) {
                    tOut.join(1000); tErr.join(1000)
                    CliResult(proc.exitValue(), outBuf.toString(), errBuf.toString())
                } else {
                    proc.destroyForcibly()
                    tOut.join(500); tErr.join(500)
                    CliResult(-1, outBuf.toString(), "claude-observatory timed out after ${timeoutMs}ms")
                }
            } else {
                val o = ExecUtil.execAndGetOutput(cmd, timeoutMs)
                // ExecUtil signals a timeout via isTimeout, not a non-zero exit — treat it as a failure
                // so callers don't mistake a killed run's partial output for a result.
                if (o.isTimeout) CliResult(-1, o.stdout, "claude-observatory timed out after ${timeoutMs}ms")
                else CliResult(o.exitCode, o.stdout, o.stderr)
            }
            out
        } catch (e: Exception) {
            CliResult(-1, "", e.message ?: "failed to launch $cmd")
        }
    }

    // --- typed wrappers over the CLI's --json surface ---

    /** Install the PreToolUse/PostToolUse capture hooks (non-interactive `claude-observatory init`). */
    fun init(workDir: String?): CliResult = run(listOf("init"), workDir)

    /** Garbage-collect orphaned blobs in a session (`clean --session <id>`). */
    fun gc(session: String, workDir: String?): CliResult = run(listOf("clean", "--session", session), workDir)

    /** Drop a whole session from the store (`clean --drop <id>`). */
    fun dropSession(session: String, workDir: String?): CliResult = run(listOf("clean", "--drop", session), workDir)

    /** Accept every pending edit in a session, then clear its records (`resolve --session <id>`).
     *  Files on disk are never touched, and the session itself is kept. */
    fun resolveSession(session: String, workDir: String?): CliResult =
        run(listOf("resolve", "--session", session, "--json"), workDir)

    /**
     * Pre-build the change maps of sessions active in the last day, DETACHED (`warm`).
     *
     * Switching to a session nothing had built measured 6.2 s against 1.5 s once its caches existed, and
     * nothing built one until you switched to it. This spends idle time instead. Fire-and-forget on
     * purpose: it must never delay the refresh that triggered it, and its failure costs a slow switch
     * rather than a broken panel — so the process is started and abandoned, never awaited.
     */
    fun warmRecent(workDir: String?) {
        try {
            val resolved = resolveBin()
            val exec = if (SystemInfo.isWindows) listOf("cmd", "/c", resolved) else listOf(resolved)
            ProcessBuilder(exec + listOf("warm", "--root", workDir ?: ".", "--since", "24h"))
                .directory(workDir?.let { java.io.File(it) })
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
        } catch (_: Exception) {
            /* no CLI on PATH — switching stays as slow as it was before 0.9.0, which is not a failure */
        }
    }

    /**
     * Drop every FINISHED session — nothing pending, conversation over (`clean --completed`).
     *
     * The predicate lives in core, not here: which sessions are safe to delete is exactly the kind of
     * rule that must not exist twice. The CLI refuses the current session, anything with pending edits,
     * anything that only just went quiet, and anything with a capture in flight.
     */
    fun cleanCompleted(workDir: String?): CliResult = run(listOf("clean", "--completed", "--json"), workDir)

    /** What `cleanCompleted` WOULD drop, without dropping it — so the confirm dialog can state real
     *  numbers instead of generic prose. The eligibility rules stay in core; this only asks. */
    fun cleanCompletedPreview(workDir: String?): CliResult =
        run(listOf("clean", "--completed", "--dry-run", "--json"), workDir)

    fun keep(session: String, id: Int, workDir: String?): Boolean =
        run(listOf("keep", id.toString(), "--session", session, "--json"), workDir).ok

    /** `keep --ids <a,b,c>` — accept an explicit set in ONE process. A scoped accept used to spawn the
     *  CLI once per edit, which on a long session is thousands of processes; this is one. Returns the
     *  kept count, or null if the call failed. */
    fun keepIds(session: String, ids: List<Int>, workDir: String?): Int? {
        if (ids.isEmpty()) return 0
        val r = run(listOf("keep", "--ids", ids.joinToString(","), "--session", session, "--json"), workDir)
        return if (r.ok) parseInt(r.stdout, "kept") else null
    }

    /** Kept count, or null if the CLI call failed (distinct from a genuine 0-pending result). */
    fun keepAll(session: String, workDir: String?): Int? {
        val r = run(listOf("keep", "--all", "--session", session, "--json"), workDir)
        return if (r.ok) parseInt(r.stdout, "kept") else null
    }

    fun undo(session: String, id: Int, force: Boolean, workDir: String?): UndoResult =
        parseUndo(run(buildList {
            add("undo"); add(id.toString()); if (force) add("--force")
            add("--session"); add(session); add("--json")
        }, workDir))

    fun redo(session: String, id: Int, force: Boolean, workDir: String?): UndoResult =
        parseUndo(run(buildList {
            add("redo"); add(id.toString()); if (force) add("--force")
            add("--session"); add(session); add("--json")
        }, workDir))

    data class UndoScopeResult(val undone: Int, val conflicts: Int, val total: Int)

    /** Revert every PENDING edit in a scope in ONE call (the CLI's `undo --all` / `undo --under`, backed
     *  by core.undoScope — the single scoped-revert implementation both editors share). `under` = null
     *  reverts the whole session; a path reverts a file (exact) or folder (everything beneath). Accepted
     *  edits are left on disk. Returns null if the CLI call failed. */
    fun undoScope(session: String, under: String?, workDir: String?): UndoScopeResult? {
        val args = buildList {
            add("undo")
            if (under == null) add("--all") else { add("--under"); add(under) }
            add("--session"); add(session); add("--json")
        }
        val r = run(args, workDir)
        if (!r.ok) return null
        return try {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            UndoScopeResult(o.get("undone").asInt, o.get("conflicts").asInt, o.get("total").asInt)
        } catch (_: Exception) {
            null
        }
    }

    data class RedoScopeResult(val redone: Int, val conflicts: Int, val total: Int)

    /** Re-apply every UNDONE edit in a scope in ONE call (the CLI's `redo --all` / `redo --under`, backed
     *  by core.redoScope — the forward mirror of undoScope). `under` = null re-applies the whole session;
     *  a path targets a file (exact) or folder (everything beneath). Returns null if the CLI call failed. */
    fun redoScope(session: String, under: String?, workDir: String?): RedoScopeResult? {
        val args = buildList {
            add("redo")
            if (under == null) add("--all") else { add("--under"); add(under) }
            add("--session"); add(session); add("--json")
        }
        val r = run(args, workDir)
        if (!r.ok) return null
        return try {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            RedoScopeResult(o.get("redone").asInt, o.get("conflicts").asInt, o.get("total").asInt)
        } catch (_: Exception) {
            null
        }
    }

    /** Revert an EXPLICIT pending-edit id set in ONE call (`undo --ids <a,b,c>`, backed by
     *  core.undoScope({ ids }) — the same set VS Code's Folder-axis Reject uses). Unlike `undoScope(under)`
     *  this targets a module bucket's EXACT edits, never the recursive subtree a path scope would catch.
     *  Accepted edits are left on disk. Returns null if the CLI call failed. */
    fun undoScopeIds(session: String, ids: List<Int>, workDir: String?): UndoScopeResult? {
        if (ids.isEmpty()) return UndoScopeResult(0, 0, 0)
        val r = run(listOf("undo", "--ids", ids.joinToString(","), "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return try {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            UndoScopeResult(o.get("undone").asInt, o.get("conflicts").asInt, o.get("total").asInt)
        } catch (_: Exception) {
            null
        }
    }

    /** `clean --resolved --json` — returns the CLI's own `cleared` count, or null on failure. The count
     *  comes from the verb, never a UI-side guess, so the toast can not disagree with what happened. */
    fun clearResolvedJson(session: String, workDir: String?): Int? {
        val r = run(listOf("clean", "--resolved", "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return try {
            com.google.gson.JsonParser.parseString(r.stdout).asJsonObject.get("cleared").asInt
        } catch (_: Exception) {
            null
        }
    }

    fun clearResolved(session: String, workDir: String?, under: String? = null): Boolean =
        run(
            listOf("clean", "--resolved", "--session", session) + (under?.let { listOf("--under", it) } ?: emptyList()),
            workDir,
        ).ok

    /** `clean --resolved --ids <a,b,c>` — clear the resolved (kept/undone) edits of an EXPLICIT id set:
     *  the scope one prompt names, which no path can express (a single ask edits many folders). Returns
     *  the cleared count, or null if the CLI call failed. */
    fun clearResolvedIds(session: String, ids: List<Int>, workDir: String?): Int? {
        if (ids.isEmpty()) return 0
        val r = run(
            listOf("clean", "--resolved", "--ids", ids.joinToString(","), "--session", session, "--json"),
            workDir,
        )
        return if (r.ok) parseInt(r.stdout, "cleared") else null
    }

    /** Per-pending-edit current line indices in the LIVE buffer text (may be unsaved). */
    fun locate(session: String, file: String, currentText: String, workDir: String?): List<Placement> {
        val r = run(listOf("locate", "--file", file, "--session", session), workDir, stdin = currentText)
        if (!r.ok) return emptyList()
        return try {
            JsonParser.parseString(r.stdout).asJsonObject.getAsJsonArray("placements").map { el ->
                val o = el.asJsonObject
                Placement(o.get("id").asInt, o.getAsJsonArray("lines").map { it.asInt })
            }
        } catch (_: Exception) {
            emptyList()
        }
    }

    /** `sessions --json` — every store session incl. its human-readable title (0.8.6), for the chooser.
     *
     *  [buildBatch] separates the two callers, which want opposite things from the batch. The POLLING
     *  path (ObservatoryService) is the batch's owner: it may build one. The Switch-Session picker must
     *  not — it names the current session too, so it would otherwise hit the same cache key and, on a
     *  cold or expired window, block the popup behind a full eight-view build INCLUDING the change map.
     *  That is precisely the multi-second stall the 0.8.8 stat-only listing removed. It peeks instead:
     *  free when the poller has already filled the window, a plain `sessions` spawn when it has not. */
    fun sessionsJson(workDir: String?, reviewing: String? = null, buildBatch: Boolean = false): String? {
        if (reviewing != null) {
            val batched = if (buildBatch) ViewBatch.view("sessions", reviewing, workDir)
            else ViewBatch.peek("sessions", reviewing, workDir)
            batched?.let { return it }
        }
        // --session names the session being reviewed, so a pinned conversation that has made no edits
        // yet is still listed rather than looking like another workspace's.
        val args = buildList {
            add("sessions"); add("--json")
            reviewing?.takeIf { it.isNotBlank() }?.let { add("--session"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    fun statsJson(session: String?, workDir: String?): String? {
        val args = buildList {
            add("stats"); add("--json")
            session?.let { add("--session"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    fun usageJson(session: String?, workDir: String?): String? {
        // --session pins the sessionTokens breakdown to the session the panel is showing, instead of
        // whatever the CLI would resolve as newest for the cwd.
        val args = buildList {
            add("usage")
            session?.let { add("--session"); add(it) }
        }
        return run(args, workDir).stdout.takeIf { it.isNotBlank() }
    }

    fun observeJson(session: String, workDir: String?): String? {
        val r = run(listOf("observe", "--session", session), workDir)
        return if (r.ok) r.stdout else null
    }

    /** The Observations view-model (0.8.0, Timeline folded in): recap + coalesced same-file ×N runs with
     *  per-edit reasoning + next-steps. Always JSON; both editors render this payload thin. */
    fun observationsJson(session: String, workDir: String?): String? {
        ViewBatch.view("observations", session, workDir)?.let { return it }
        val args = buildList {
            add("observations"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** `task-keep <taskId>` — keep every PENDING edit in a task's STRICT in_progress span. Returns
     *  the kept count, or null if the CLI call failed (distinct from a genuine 0-pending task). */
    fun taskKeep(session: String, taskId: String, workDir: String?): Int? {
        val r = run(listOf("task-keep", taskId, "--session", session, "--json"), workDir)
        return if (r.ok) parseInt(r.stdout, "kept") else null
    }

    data class TaskUndoResult(val undone: Int, val conflicts: Int, val total: Int)

    /** `task-undo <taskId>` — revert every PENDING edit in a task's STRICT span, newest-first.
     *  Writes to disk. Returns {undone, conflicts, total}, or null if the CLI call failed. */
    fun taskUndo(session: String, taskId: String, workDir: String?): TaskUndoResult? {
        val r = run(listOf("task-undo", taskId, "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return try {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            TaskUndoResult(o.get("undone").asInt, o.get("conflicts").asInt, o.get("total").asInt)
        } catch (_: Exception) {
            null
        }
    }

    /** `task-clear <taskId>` — drop the RESOLVED (kept/undone) edits of a task's STRICT span;
     *  pending edits are preserved. Returns the cleared count, or null if the CLI call failed. */
    fun taskClear(session: String, taskId: String, workDir: String?): Int? {
        val r = run(listOf("task-clear", taskId, "--session", session, "--json"), workDir)
        return if (r.ok) parseInt(r.stdout, "cleared") else null
    }

    data class TaskClearCompletedResult(val cleared: Int, val tasks: Int)

    /** `task-clear --completed` — clear the resolved edits of EVERY settled task (all kept).
     *  Returns {cleared, tasks}, or null if the CLI call failed. */
    fun taskClearCompleted(session: String, workDir: String?): TaskClearCompletedResult? {
        val r = run(listOf("task-clear", "--completed", "--session", session, "--json"), workDir)
        if (!r.ok) return null
        return try {
            val o = JsonParser.parseString(r.stdout).asJsonObject
            TaskClearCompletedResult(o.get("cleared").asInt, o.getAsJsonArray("tasks")?.size() ?: 0)
        } catch (_: Exception) {
            null
        }
    }

    /** The folder→file→class→edit view-model (with exact deltas) — the single source both editors render. */
    fun treeJson(session: String, workDir: String?, filter: String?): String? {
        val args = buildList {
            add("tree"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
            if (!filter.isNullOrBlank()) { add("--filter"); add(filter) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** The session change-map: per-file / per-module rollups of everything Claude
     *  touched. Every number (churn, status precedence, module labels) is computed by core — this
     *  plugin only renders the result, exactly like the VS Code webview. */
    fun changemapJson(session: String, workDir: String?): String? {
        ViewBatch.view("changemap", session, workDir)?.let { return it }
        val args = buildList {
            add("changemap"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
            add("--json")
        }
        val r = run(args, workDir, timeoutMs = HEAVY_TIMEOUT_MS)
        return if (r.ok) r.stdout else null
    }

    /** The multi-agent view: one row per running agent across every worktree (live phase, sparkline,
     *  ±diff, risk), nested subagents, and cross-agent file collisions. `--root` keys the repo-scoped
     *  fleet. Everything is aggregated in core — the panel only paints.
     *
     *  `--session` pins WHICH sibling is the payload's own: it decides the fleet's `self` row and the
     *  session-scoped sections (actions, tasks). Without it the CLI re-resolves the newest session for
     *  the cwd, so after Switch Session every one of those still described the session you left. */
    fun multitaskJson(session: String?, workDir: String?): String? {
        ViewBatch.view("multitask", session, workDir)?.let { return it }
        val args = buildList {
            add("multitask"); add("--json")
            session?.takeIf { it.isNotBlank() }?.let { add("--session"); add(it) }
            workDir?.let { add("--root"); add(it) }
        }
        val r = run(args, workDir, timeoutMs = HEAVY_TIMEOUT_MS)
        return if (r.ok) r.stdout else null
    }

    /** `risk --json` — the flagged shell commands AND (0.8.7) the edits that landed OUTSIDE the
     *  workspace. `--root` is the boundary "outside" is measured against; without it the CLI falls back
     *  to its own cwd, which is not the project root whenever the IDE was launched from elsewhere. */
    fun riskJson(session: String, workDir: String?): String? {
        ViewBatch.view("risk", session, workDir)?.let { return it }
        val args = buildList {
            add("risk"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
            add("--json")
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** `egress --json` — every destination this session reached: web hosts, MCP servers, network shell,
     *  and (0.8.7) the files it READ from outside the workspace. Only this verb carries those `file`
     *  channels; the `multitask --json` egress sub-report predates the fold and would omit them. */
    fun egressJson(session: String, workDir: String?): String? {
        ViewBatch.view("egress", session, workDir)?.let { return it }
        val args = buildList {
            add("egress"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
            add("--json")
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** The background shells this session launched with `run_in_background` and left running — runtime,
     *  exit code, output volume. No OS pid is reported because none exists to report: the transcript
     *  never records one, and guessing it from local processes breaks the moment the agent runs over
     *  SSH or in a container. */
    fun processesJson(session: String, workDir: String?): String? {
        ViewBatch.view("processes", session, workDir)?.let { return it }
        val r = run(listOf("processes", "--session", session, "--json"), workDir)
        return if (r.ok) r.stdout else null
    }

    /** The session as the list of things the USER asked for — each ask with the edits, tool calls,
     *  subagents, workflow runs and background shells it produced. Work is attributed to the prompt that
     *  STARTED it (core's rule), so nothing here re-attributes by completion. */
    fun promptsJson(session: String, workDir: String?): String? {
        ViewBatch.view("prompts", session, workDir)?.let { return it }
        val r = run(listOf("prompts", "--session", session, "--json"), workDir)
        return if (r.ok) r.stdout else null
    }

    /** Claude's prose reply to one ask (its tool calls stripped) — the log a reviewer expands to read.
     *  Fetched on demand because it can be large. */
    fun promptResponseJson(session: String, promptId: String, workDir: String?): String? {
        val r = run(listOf("prompts", "--id", promptId, "--response", "--session", session, "--json"), workDir)
        return if (r.ok) r.stdout else null
    }

    /** A bounded tail of what ONE thing is doing: an agent, a workflow run, a task, a background shell,
     *  or the session itself. core decides whether the source is still writing ('live') or has finished
     *  ('audit'), so both editors follow — and stop following — the same things. */
    fun feedJson(session: String, kind: String, id: String, limit: Int, workDir: String?): String? {
        val args = buildList {
            add("feed"); add("--kind"); add(kind)
            if (id.isNotBlank()) { add("--id"); add(id) }
            add("--limit"); add(limit.toString())
            add("--session"); add(session)
            add("--json")
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** Zero-token chat handoff: core assembles a ready-to-paste review prompt for an edit / subagent /
     *  task / action (or the whole session), which the caller copies to the clipboard. NEVER calls a
     *  model — this only reads the store + transcripts. Returns the prompt, or null if the CLI failed. */
    fun chatContextJson(session: String, workDir: String?, ref: ChatRef): String? {
        val args = buildList {
            add("chat-context"); add("--json")
            when (ref) {
                is ChatRef.Edit -> { add("--edit"); add(ref.id.toString()) }
                is ChatRef.Agent -> { add("--agent"); add(ref.agentId) }
                is ChatRef.Task -> { add("--task"); add(ref.taskId) }
                is ChatRef.ToolUse -> { add("--tool-use-id"); add(ref.toolUseId) }
                ChatRef.Session -> {} // no ref flag → session-level framing
            }
            add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
        }
        val r = run(args, workDir)
        if (!r.ok) return null
        return try {
            JsonParser.parseString(r.stdout).asJsonObject.get("prompt")?.takeIf { !it.isJsonNull }?.asString
        } catch (_: Exception) {
            null
        }
    }

    /** Portable markdown review summary (kept/reverted per file) for export. */
    fun summaryMarkdown(session: String, workDir: String?): String? {
        val r = run(listOf("summary", "--markdown", "--session", session), workDir)
        return if (r.ok) r.stdout else null
    }

    /** Setup diagnostics as markdown. `doctor` exits 1 when there are failures but still prints, so
     *  we take stdout regardless of the exit code. */
    fun doctorMarkdown(workDir: String?): String? =
        run(listOf("doctor", "--markdown"), workDir).stdout.takeIf { it.isNotBlank() }

    /** `--claude-bin <path>` when the user set an explicit claude CLI path (Settings → Tools → Claude
     *  Observatory). Without this the setting is dead: a GUI-launched IDE with a stripped PATH can't
     *  find `claude`, and Analyze/Recap fail even though the user pointed us at the binary. */
    private fun claudeBinArgs(): List<String> =
        ObservatorySettings.instance.state.claudeBin?.takeIf { it.isNotBlank() }
            ?.let { listOf("--claude-bin", it) } ?: emptyList()

    /** Opt-in `claude -p` layer: cached unless fresh; can run for minutes. Returns text or null. */
    fun analyze(session: String, id: Int, workDir: String?): String? {
        val args = listOf("analyze", id.toString(), "--session", session, "--json") + claudeBinArgs()
        val r = run(args, workDir, timeoutMs = 150_000)
        return analysisText(r)
    }

    fun recap(session: String, fresh: Boolean, workDir: String?): String? {
        val args = buildList {
            add("recap"); add("--session"); add(session); add("--json"); if (fresh) add("--fresh")
            addAll(claudeBinArgs())
        }
        return analysisText(run(args, workDir, timeoutMs = 150_000))
    }

    private fun analysisText(r: CliResult): String? = try {
        if (r.ok) JsonParser.parseString(r.stdout).asJsonObject.get("text").asString else null
    } catch (_: Exception) {
        null
    }

    // --- demo mode + the guided tour (0.8.9) ---------------------------------------------------------

    /**
     * Replay the demo session, STREAMING its per-beat narration instead of waiting for the process.
     *
     * `run` is spawn-and-wait with a 30s cap, and a paced replay is ~20s — already inside the noise
     * margin, and `--speed 0.5` would blow straight past it. Streaming buys three things a longer
     * timeout does not: the progress bar narrates each beat as it lands, the panels can be refreshed
     * per beat rather than once at the end, and Cancel can actually stop it.
     *
     * A cancelled run leaves a partial demo, which `demoClean` removes exactly like a complete one.
     * Returns the exit code with the narration joined, for the caller's error path.
     */
    fun demoStreaming(args: List<String>, workDir: String?, isCancelled: () -> Boolean, onLine: (String) -> Unit): CliResult {
        return try {
            val handler = OSProcessHandler(commandLine(listOf("demo") + args, workDir))
            // StringBuffer, not StringBuilder: these are appended from the process reader thread and
            // read from this one after an ASYNCHRONOUS destroyProcess(), so there is no happens-before
            // edge to rely on — a torn read used to surface a plain cancel as "could not start".
            val out = StringBuffer()
            val err = StringBuffer()
            handler.addProcessListener(object : ProcessAdapter() {
                override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                    // stderr is the only place a failing run says WHY; dropping it left every failure
                    // reported as "is the CLI installed?", the one cause already ruled out.
                    if (outputType == ProcessOutputTypes.STDERR) { err.append(event.text); return }
                    if (outputType != ProcessOutputTypes.STDOUT) return
                    out.append(event.text)
                    event.text.lineSequence().map { it.trim() }.filter { it.isNotEmpty() }.forEach(onLine)
                }
            })
            handler.startNotify()
            var cancelled = false
            while (!handler.waitFor(200)) {
                if (isCancelled()) { handler.destroyProcess(); cancelled = true; break }
            }
            CliResult(
                if (cancelled) -1 else (handler.exitCode ?: -1),
                out.toString(),
                if (cancelled) "cancelled" else err.toString(),
            )
        } catch (e: Exception) {
            CliResult(-1, "", e.message ?: "failed to launch the demo")
        }
    }

    /**
     * The guided tour's script. Core owns it, so this and the VS Code panel render the same tour.
     *
     * Capability-probed first, and that is not defensive habit: a pre-0.8.9 CLI does not reject
     * `demo --tour --json` — it ignores the unknown flag, honours `--json`, and REPLAYS AN ENTIRE DEMO
     * as the side effect of being asked for a script. Asking `help` what it supports costs one cheap
     * process and cannot mutate anything.
     */
    fun demoTour(workDir: String?, essentials: Boolean = false): List<DemoStep> {
        if (!run(listOf("help"), workDir).stdout.contains("demo --tour")) return emptyList()
        val args = buildList { add("demo"); add("--tour"); if (essentials) add("--essentials"); add("--json") }
        val r = run(args, workDir)
        return if (r.ok) TourParser.parse(r.stdout) else emptyList()
    }

    /** Keep a running demo inside the fleet's 60s active window — mtime only, nothing is written.
     *  Called on tour step advance ONLY: this touches watched files, so calling it from a refresh
     *  would wake the watcher that triggered it, forever. */
    fun demoTouch(workDir: String?): CliResult = run(listOf("demo", "--touch", "--json"), workDir)

    /** Remove every trace: both sessions, their stores, the demo folder, and the scratch dir. */
    fun demoClean(workDir: String?): CliResult = run(listOf("demo", "--clean", "--json"), workDir)

    /** The primary session id a streamed replay reported. Its final narration line names it, and the
     *  sibling agent's id is never printed — so this is exact, where picking one out of the store would
     *  have to assume an ordering. Null when the run printed nothing (a failed spawn, or a cancel
     *  before the first beat), and the caller falls back to [demoSession]. */
    fun demoSessionFrom(stdout: String): String? =
        DEMO_ID_IN_TEXT.findAll(stdout).lastOrNull()?.value

    private val DEMO_ID_IN_TEXT = Regex("demo-[0-9a-f]{8}")

    /** The demo session id for this project, or null — how the plugin finds a demo it did not itself
     *  just start (one a crashed IDE left behind, since demo mode persists no state of its own). */
    fun demoSession(workDir: String?): String? = try {
        val r = run(listOf("sessions", "--json"), workDir)
        if (!r.ok) null
        else JsonParser.parseString(r.stdout).asJsonObject.getAsJsonArray("sessions")
            .mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.get("id")?.asString }
            .firstOrNull { DEMO_ID.matches(it) }
    } catch (_: Exception) {
        null
    }

    /** The same gate core applies — `demo-<8hex>` and nothing else may drive demo-only behaviour. */
    private val DEMO_ID = Regex("^demo-[0-9a-f]{8}$")

    fun isDemoSession(id: String?): Boolean = id != null && DEMO_ID.matches(id)

    private fun parseUndo(r: CliResult): UndoResult = try {
        val o = JsonParser.parseString(r.stdout).asJsonObject
        UndoResult(o.get("ok").asBoolean, o.get("status").asString, o.get("message").asString)
    } catch (_: Exception) {
        UndoResult(false, "error", r.stderr.ifBlank { "claude-observatory CLI not found — install it and set its path in Settings → Tools → Claude Observatory" })
    }

    private fun parseInt(json: String, key: String): Int = try {
        JsonParser.parseString(json).asJsonObject.get(key).asInt
    } catch (_: Exception) {
        0
    }
}

/** What a zero-token chat handoff is about — maps 1:1 to `chat-context`'s ref flags (§7). */
sealed class ChatRef {
    /** No ref flag → a whole-session framing prompt. */
    object Session : ChatRef()
    data class Edit(val id: Int) : ChatRef()          // --edit <n>
    data class Agent(val agentId: String) : ChatRef() // --agent <id> (a subagent)
    data class Task(val taskId: String) : ChatRef()   // --task <id>
    data class ToolUse(val toolUseId: String) : ChatRef() // --tool-use-id <id>
}
