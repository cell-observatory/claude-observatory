package com.cellobservatory.observatory.core

import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.attribute.BasicFileAttributes
import java.util.concurrent.ConcurrentHashMap
import kotlin.io.path.exists
import kotlin.io.path.listDirectoryEntries

/**
 * Resolve the active Claude Code session for a directory — port of core's session.ts: the newest
 * `*.jsonl` in <config>/projects/<mangled-cwd> that holds a real conversation (hasAssistantRecord),
 * walking UP parent directories so a project opened in a subdirectory still finds the session
 * Claude was launched in. Local commands (/effort, /model) and bridge-session records write
 * transcripts that never gain an assistant record; they must not win the newest-mtime race over
 * the real session. When NO candidate has one yet (first turn in flight), newest wins as before.
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
            val candidates = dir.listDirectoryEntries("*.jsonl")
                .mapNotNull { p ->
                    try {
                        p to Files.getLastModifiedTime(p).toMillis()
                    } catch (_: Exception) {
                        null
                    }
                }
                .sortedByDescending { it.second }
            val real = candidates.firstOrNull { hasAssistantRecord(it.first) } ?: candidates.firstOrNull()
            real?.first?.fileName?.toString()?.removeSuffix(".jsonl")
        } catch (_: Exception) {
            null
        }
    }

    // Positive results are sticky (transcripts are append-only: once a session has replied it stays
    // real forever). A negative is keyed on (mtimeMs,size) so a still-growing brand-new transcript
    // is re-scanned when it changes, while a dead stub costs one stat per lookup.
    private val assistantSeen: MutableSet<Path> = ConcurrentHashMap.newKeySet()
    private val assistantNegKey = ConcurrentHashMap<Path, String>()

    /**
     * True iff the transcript contains a `type:"assistant"` record — the discriminator between a
     * real session and a command-only/bridge stub. Mirrors session.ts hasAssistantRecord: bounded
     * scan, substring prefilter, parse-confirm (pasted content inside a user record can embed the
     * literal `"type":"assistant"`; only a record whose own type field is assistant counts).
     */
    fun hasAssistantRecord(transcript: Path): Boolean {
        if (transcript in assistantSeen) return true
        val negKey = try {
            val attrs = Files.readAttributes(transcript, BasicFileAttributes::class.java)
            "${attrs.lastModifiedTime().toMillis()}:${attrs.size()}"
        } catch (_: Exception) {
            return false
        }
        if (assistantNegKey[transcript] == negKey) return false
        val found = try {
            scanForAssistant(transcript)
        } catch (_: Exception) {
            false
        }
        if (found) {
            assistantSeen.add(transcript)
            assistantNegKey.remove(transcript)
        } else {
            assistantNegKey[transcript] = negKey
        }
        return found
    }

    private const val MAX_SCAN = 32L * 1024 * 1024 // same bound as session.ts — never load a whole 20-56MB file

    private fun scanForAssistant(transcript: Path): Boolean {
        Files.newBufferedReader(transcript, Charsets.UTF_8).use { reader ->
            var scanned = 0L // chars ≈ bytes for JSONL; a pathological-file guard, not exact accounting
            for (line in reader.lineSequence()) {
                scanned += line.length + 1
                if (isAssistantLine(line)) return true
                if (scanned > MAX_SCAN) return false
            }
        }
        return false
    }

    private fun isAssistantLine(line: String): Boolean {
        if ("\"type\":\"assistant\"" !in line && "\"type\": \"assistant\"" !in line) return false
        return try {
            val o = JsonParser.parseString(line).asJsonObject
            o.get("type")?.takeIf { it.isJsonPrimitive }?.asString == "assistant"
        } catch (_: Exception) {
            false // partial/corrupt line — a real record will parse on a later scan
        }
    }
}
