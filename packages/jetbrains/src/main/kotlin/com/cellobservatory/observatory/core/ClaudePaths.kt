package com.cellobservatory.observatory.core

import com.cellobservatory.observatory.settings.ObservatorySettings
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Single source of truth for Claude paths — mirrors core's paths.ts/session.ts exactly.
 * Everything lives under CLAUDE_CONFIG_DIR (settings override first, then the env var Claude Code
 * itself honors), defaulting to ~/.claude — devcontainers relocate it onto a persistent volume.
 */
object ClaudePaths {
    /** Test seam: unit tests point the whole path layer at a temp dir without an IDE application. */
    @Volatile
    var configDirOverride: Path? = null

    fun configDir(): Path {
        configDirOverride?.let { return it }
        // runCatching: the settings service needs a running Application — absent in unit tests
        // and during very early startup; fall back to the env var Claude Code itself honors.
        val fromSettings = runCatching { ObservatorySettings.instance.state.configDir }.getOrNull()
        if (!fromSettings.isNullOrBlank()) return Paths.get(fromSettings)
        System.getenv("CLAUDE_CONFIG_DIR")?.takeIf { it.isNotBlank() }?.let { return Paths.get(it) }
        return Paths.get(System.getProperty("user.home"), ".claude")
    }

    /** The edit store root: <config>/claude-observatory */
    fun rootDir(): Path = configDir().resolve("claude-observatory")

    fun storeDir(sessionId: String): Path = rootDir().resolve(sessionId)

    fun logPath(sessionId: String): Path = storeDir(sessionId).resolve("log.jsonl")

    fun blobPath(sessionId: String, sha: String): Path = storeDir(sessionId).resolve("blobs").resolve(sha)

    /** Claude Code's project-dir mangling: every non-alphanumeric char becomes '-'. */
    fun mangleCwd(cwd: String): String = cwd.replace(Regex("[^a-zA-Z0-9]"), "-")

    fun projectDir(cwd: String): Path = configDir().resolve("projects").resolve(mangleCwd(cwd))

    fun statuslineCache(): Path = configDir().resolve("statusline-last.json")
}
