package com.cellobservatory.observatory.core

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.SessionInfo
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.listDirectoryEntries
import kotlin.io.path.readText

/**
 * Read-only view of the on-disk store (log.jsonl + blobs). Mirrors core's store.ts read path:
 * the log is append-only with two line shapes — EditRecord lines and `{op:"status",id,status}`
 * ops that are FOLDED onto the matching record in file order. Unparseable/partial lines are
 * skipped (a concurrent capture may be mid-append). All mutations go through the CLI, never here.
 */
object StoreReader {

    fun readLog(sessionId: String): List<EditRecord> {
        val path = ClaudePaths.logPath(sessionId)
        if (!path.exists()) return emptyList()
        val text = try {
            path.readText()
        } catch (_: Exception) {
            return emptyList()
        }
        val records = LinkedHashMap<Int, EditRecord>()
        for (line in text.lineSequence()) {
            val t = line.trim()
            if (t.isEmpty()) continue
            val o = try {
                JsonParser.parseString(t).asJsonObject
            } catch (_: Exception) {
                continue
            }
            if (o.get("op")?.takeIf { it.isJsonPrimitive }?.asString == "status") {
                val id = o.get("id")?.asIntOrNull() ?: continue
                val status = o.get("status")?.asStringOrNull() ?: continue
                records[id]?.let { records[id] = it.copy(status = status) }
                continue
            }
            val id = o.get("id")?.asIntOrNull() ?: continue
            // canonPath mirrors core's readLog heal (#43): pre-fix stores hold drive-letter case twins
            // for one file; normalizing here makes every panel see one file without rewriting disk.
            val file = o.get("file")?.asStringOrNull()?.let { ClaudePaths.canonPath(it) } ?: continue
            records[id] = EditRecord(
                id = id,
                ts = o.get("ts")?.asLongOrNull() ?: 0L,
                tool = o.get("tool")?.asStringOrNull() ?: "",
                file = file,
                beforeBlob = o.get("beforeBlob")?.asStringOrNull(),
                afterBlob = o.get("afterBlob")?.asStringOrNull(),
                status = o.get("status")?.asStringOrNull() ?: "pending",
            )
        }
        return records.values.toList()
    }

    fun findRecord(sessionId: String, id: Int): EditRecord? = readLog(sessionId).find { it.id == id }

    fun readBlob(sessionId: String, sha: String?): String {
        if (sha == null) return ""
        return try {
            Files.readString(ClaudePaths.blobPath(sessionId, sha))
        } catch (_: Exception) {
            ""
        }
    }

    fun listSessions(): List<SessionInfo> {
        val root = ClaudePaths.rootDir()
        if (!root.exists()) return emptyList()
        return root.listDirectoryEntries()
            .filter { Files.isDirectory(it) && it.resolve("log.jsonl").exists() }
            .map { dir ->
                val log = readLog(dir.fileName.toString())
                // mtime of log.jsonl — matches core.listSessions (store.ts). Status ops (keep/undo)
                // bump the mtime but not any record.ts, so max(edit.ts) would drift after review.
                val lastMs = try {
                    Files.getLastModifiedTime(dir.resolve("log.jsonl")).toMillis()
                } catch (_: Exception) {
                    0L
                }
                SessionInfo(
                    id = dir.fileName.toString(),
                    edits = log.size,
                    pending = log.count { it.pending },
                    lastMs = lastMs,
                )
            }
            .sortedByDescending { it.lastMs }
    }

    /** (mtime, size) freshness key for the session log — cheap cache invalidation, same as core. */
    fun logKey(sessionId: String): String {
        val p = ClaudePaths.logPath(sessionId)
        return try {
            val attrs = Files.readAttributes(p, java.nio.file.attribute.BasicFileAttributes::class.java)
            "${attrs.lastModifiedTime().toMillis()}:${attrs.size()}"
        } catch (_: Exception) {
            "absent"
        }
    }
}

private fun com.google.gson.JsonElement.asIntOrNull(): Int? =
    if (isJsonPrimitive && asJsonPrimitive.isNumber) asInt else null

private fun com.google.gson.JsonElement.asLongOrNull(): Long? =
    if (isJsonPrimitive && asJsonPrimitive.isNumber) asLong else null

private fun com.google.gson.JsonElement.asStringOrNull(): String? =
    if (isJsonPrimitive && asJsonPrimitive.isString) asString else null
