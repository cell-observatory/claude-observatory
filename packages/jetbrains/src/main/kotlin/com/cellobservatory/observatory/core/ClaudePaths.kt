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

    /** True if the capture hooks are wired into settings.json — same marker install.ts writes. */
    fun hooksInstalled(): Boolean = runCatching {
        java.nio.file.Files.readString(configDir().resolve("settings.json")).contains("claude-observatory-hook")
    }.getOrDefault(false)

    /**
     * Canonicalize a path's DRIVE-LETTER case — the Kotlin mirror of core's canonPath (issue #43).
     * Same total, platform-independent string transform; see paths.ts for the full rationale.
     */
    fun canonPath(p: String): String {
        if (p.length >= 2 && p[1] == ':' && (p.length == 2 || p[2] == '\\' || p[2] == '/')) {
            val d = p[0]
            if (d in 'a'..'z') return d.uppercaseChar() + p.substring(1)
        }
        return p
    }

    /**
     * Editor→store path bridge (#43): IntelliJ VirtualFile paths are system-independent
     * (`C:/repo/x.ts`) while store records are OS-native (`C:\repo\x.ts` on Windows) — so a raw
     * `record.file == vf.path` join can never match on Windows. Flips separators only for
     * drive-letter-shaped paths (a backslash is a legal filename character on POSIX, and the drive
     * shape is what makes it unambiguously a Windows path), then canonicalizes the drive case.
     * UNC paths (`//server/share`) are left as-is — out of #43's scope.
     */
    fun storeKey(editorPath: String): String {
        val driveShaped = editorPath.length >= 2 && editorPath[1] == ':' &&
            (editorPath.length == 2 || editorPath[2] == '/' || editorPath[2] == '\\')
        val native = if (driveShaped) editorPath.replace('/', '\\') else editorPath
        return canonPath(native)
    }
}
