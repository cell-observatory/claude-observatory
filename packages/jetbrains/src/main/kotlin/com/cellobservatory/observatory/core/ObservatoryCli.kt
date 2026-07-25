package com.cellobservatory.observatory.core

import com.cellobservatory.observatory.model.Placement
import com.cellobservatory.observatory.model.UndoResult
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.google.gson.JsonParser
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.util.ExecUtil
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

    fun run(args: List<String>, workDir: String? = null, stdin: String? = null, timeoutMs: Int = 30_000): CliResult {
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

    /** `sessions --json` — every store session incl. its human-readable title (0.8.6), for the chooser. */
    fun sessionsJson(workDir: String?, reviewing: String? = null): String? {
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
        val args = buildList {
            add("changemap"); add("--session"); add(session)
            workDir?.let { add("--root"); add(it) }
            add("--json")
        }
        val r = run(args, workDir)
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
        val args = buildList {
            add("multitask"); add("--json")
            session?.takeIf { it.isNotBlank() }?.let { add("--session"); add(it) }
            workDir?.let { add("--root"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    /** `risk --json` — the flagged shell commands AND (0.8.7) the edits that landed OUTSIDE the
     *  workspace. `--root` is the boundary "outside" is measured against; without it the CLI falls back
     *  to its own cwd, which is not the project root whenever the IDE was launched from elsewhere. */
    fun riskJson(session: String, workDir: String?): String? {
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
        val r = run(listOf("processes", "--session", session, "--json"), workDir)
        return if (r.ok) r.stdout else null
    }

    /** The session as the list of things the USER asked for — each ask with the edits, tool calls,
     *  subagents, workflow runs and background shells it produced. Work is attributed to the prompt that
     *  STARTED it (core's rule), so nothing here re-attributes by completion. */
    fun promptsJson(session: String, workDir: String?): String? {
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
