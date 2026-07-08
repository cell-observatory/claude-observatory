package com.cellobservatory.observatory.core

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import kotlin.io.path.exists
import kotlin.io.path.listDirectoryEntries

/**
 * Resolve the active Claude Code session for a directory — port of core's session.ts: the newest
 * `*.jsonl` (by mtime) in <config>/projects/<mangled-cwd>, walking UP parent directories so a
 * project opened in a subdirectory still finds the session Claude was launched in.
 */
object SessionResolver {

    fun resolveSessionId(cwd: String): String? {
        var dir: Path? = Paths.get(cwd).toAbsolutePath().normalize()
        while (dir != null) {
            newestSessionIn(ClaudePaths.projectDir(dir.toString()))?.let { return it }
            dir = dir.parent
        }
        return null
    }

    fun findTranscript(cwd: String, sessionId: String): Path? {
        var dir: Path? = Paths.get(cwd).toAbsolutePath().normalize()
        while (dir != null) {
            val p = ClaudePaths.projectDir(dir.toString()).resolve("$sessionId.jsonl")
            if (p.exists()) return p
            dir = dir.parent
        }
        return null
    }

    private fun newestSessionIn(dir: Path): String? {
        if (!dir.exists()) return null
        return try {
            dir.listDirectoryEntries("*.jsonl")
                .maxByOrNull { Files.getLastModifiedTime(it).toMillis() }
                ?.fileName?.toString()?.removeSuffix(".jsonl")
        } catch (_: Exception) {
            null
        }
    }
}
