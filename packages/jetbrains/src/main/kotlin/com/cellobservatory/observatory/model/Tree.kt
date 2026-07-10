package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's EditTree view-model, parsed from `claude-observatory tree --json`.
 * Folder compaction, class grouping, exact deltas, and Search filtering are all computed server-side
 * in core.buildEditTree — this plugin only renders the result (no more local tree/class logic).
 */
data class TreeEditNode(val rec: EditRecord, val added: Int, val removed: Int)
data class TreeClassNode(val name: String, val edits: List<TreeEditNode>)
data class TreeFileNode(val rel: String, val file: String, val classes: List<TreeClassNode>, val loose: List<TreeEditNode>) {
    /** Every edit under this file (class-grouped + loose), for the file-scoped Undo-All action. */
    val allEdits: List<EditRecord> get() = classes.flatMap { c -> c.edits.map { it.rec } } + loose.map { it.rec }
}
data class TreeFolderNode(val label: String, val folders: List<TreeFolderNode>, val files: List<TreeFileNode>)
data class EditTree(val folders: List<TreeFolderNode>, val files: List<TreeFileNode>)

object TreeParser {
    fun parse(json: String): EditTree? = try {
        val o = JsonParser.parseString(json).asJsonObject
        EditTree(
            o.getAsJsonArray("folders").map { folder(it.asJsonObject) },
            o.getAsJsonArray("files").map { file(it.asJsonObject) },
        )
    } catch (_: Exception) {
        null
    }

    private fun folder(o: JsonObject): TreeFolderNode = TreeFolderNode(
        o.get("label").asString,
        o.getAsJsonArray("folders").map { folder(it.asJsonObject) },
        o.getAsJsonArray("files").map { file(it.asJsonObject) },
    )

    private fun file(o: JsonObject): TreeFileNode = TreeFileNode(
        o.get("rel").asString,
        o.get("file").asString,
        o.getAsJsonArray("classes").map { cls(it.asJsonObject) },
        o.getAsJsonArray("loose").map { edit(it.asJsonObject) },
    )

    private fun cls(o: JsonObject): TreeClassNode =
        TreeClassNode(o.get("name").asString, o.getAsJsonArray("edits").map { edit(it.asJsonObject) })

    private fun edit(o: JsonObject): TreeEditNode {
        val rec = EditRecord(
            o.get("id").asInt,
            o.get("ts").asLong,
            o.get("tool").asString,
            o.get("file").asString,
            o.get("beforeBlob").let { if (it.isJsonNull) null else it.asString },
            o.get("afterBlob").let { if (it.isJsonNull) null else it.asString },
            o.get("status").asString,
        )
        return TreeEditNode(rec, o.get("added").asInt, o.get("removed").asInt)
    }
}
