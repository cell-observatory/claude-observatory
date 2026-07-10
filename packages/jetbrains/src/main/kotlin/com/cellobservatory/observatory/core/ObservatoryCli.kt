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

    fun keep(session: String, id: Int, workDir: String?): Boolean =
        run(listOf("keep", id.toString(), "--session", session, "--json"), workDir).ok

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

    fun clearResolved(session: String, workDir: String?): Boolean =
        run(listOf("clean", "--resolved", "--session", session), workDir).ok

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

    fun statsJson(session: String?, workDir: String?): String? {
        val args = buildList {
            add("stats"); add("--json")
            session?.let { add("--session"); add(it) }
        }
        val r = run(args, workDir)
        return if (r.ok) r.stdout else null
    }

    fun usageJson(workDir: String?): String? = run(listOf("usage"), workDir).stdout.takeIf { it.isNotBlank() }

    fun observeJson(session: String, workDir: String?): String? {
        val r = run(listOf("observe", "--session", session), workDir)
        return if (r.ok) r.stdout else null
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
