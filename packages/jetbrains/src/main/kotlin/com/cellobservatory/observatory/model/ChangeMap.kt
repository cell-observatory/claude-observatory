package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's ChangeMap view-model, parsed from `claude-observatory changemap --json`.
 * Churn rollups, the worst-unreviewed-wins status precedence, module labels, and the drill-through
 * target (`maxId`) are all computed server-side in core.buildChangeMap — this plugin only renders the
 * result (no local aggregation, so VS Code and JetBrains can never disagree about the numbers).
 */
data class ChangeMapChapter(
    val id: String,
    val index: Int,
    val title: String,
    /** "done" | "wip" | "todo" — from Claude's own to-do status. */
    val status: String,
    val edits: Int,
    val kept: Int,
    val pending: Int,
    val undone: Int,
    val agent: Boolean,
)

data class ChangeMapFile(
    val rel: String,
    val module: String,
    val moduleLabel: String,
    val file: String,
    val churn: Int,
    val cnt: Int,
    val kept: Int,
    val pending: Int,
    val undone: Int,
    /** "pending" | "undone" | "kept" — worst-unreviewed-wins. */
    val status: String,
    /** Most-recent edit id — what a double-click opens. */
    val maxId: Int,
    val classes: List<String>,
    val chapters: List<String>,
    val agent: Boolean,
    val risk: String?,
    val reason: String?,
)

data class ChangeMapModule(
    val module: String,
    val label: String,
    val churn: Int,
    val cnt: Int,
    val kept: Int,
    val pending: Int,
    val undone: Int,
    val status: String,
    val files: Int,
    val chapters: List<String>,
)

data class ChangeMapSummary(
    val session: String,
    val units: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
    val errors: Int,
    val subagents: Int,
    /** Sibling sessions in this project (the 🛰 chip) — same headline the VS Code panel shows. */
    val fleet: Int,
    /** Off-machine destinations this session reached (the ⇅ chip). */
    val egress: Int,
)

data class ChangeMap(
    val summary: ChangeMapSummary?,
    val chapters: List<ChangeMapChapter>,
    val files: List<ChangeMapFile>,
    val modules: List<ChangeMapModule>,
)

object ChangeMapParser {
    fun parse(json: String): ChangeMap? = try {
        val o = JsonParser.parseString(json).asJsonObject
        ChangeMap(
            o.getAsJsonObject("summary")?.let { summary(it) },
            arr(o, "chapters").map { chapter(it.asJsonObject) },
            arr(o, "files").map { file(it.asJsonObject) },
            arr(o, "modules").map { module(it.asJsonObject) },
        )
    } catch (_: Exception) {
        null
    }

    /** Tolerate a missing array (an older CLI that predates a field) rather than throwing the map away. */
    private fun arr(o: JsonObject, k: String) = o.getAsJsonArray(k) ?: com.google.gson.JsonArray()

    private fun str(o: JsonObject, k: String): String? =
        o.get(k)?.takeIf { !it.isJsonNull }?.asString

    private fun int(o: JsonObject, k: String): Int =
        o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0

    private fun bool(o: JsonObject, k: String): Boolean =
        o.get(k)?.takeIf { !it.isJsonNull }?.asBoolean ?: false

    private fun strings(o: JsonObject, k: String): List<String> =
        (o.getAsJsonArray(k) ?: com.google.gson.JsonArray()).mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString }

    private fun summary(o: JsonObject) = ChangeMapSummary(
        str(o, "session") ?: "",
        int(o, "units"), int(o, "pending"), int(o, "kept"), int(o, "undone"),
        int(o, "errors"), int(o, "subagents"), int(o, "fleet"), int(o, "egress"),
    )

    private fun chapter(o: JsonObject) = ChangeMapChapter(
        str(o, "id") ?: "", int(o, "index"), str(o, "title") ?: "", str(o, "status") ?: "todo",
        int(o, "edits"), int(o, "kept"), int(o, "pending"), int(o, "undone"), bool(o, "agent"),
    )

    private fun file(o: JsonObject) = ChangeMapFile(
        str(o, "rel") ?: "", str(o, "module") ?: "", str(o, "moduleLabel") ?: "", str(o, "file") ?: "",
        int(o, "churn"), int(o, "cnt"), int(o, "kept"), int(o, "pending"), int(o, "undone"),
        str(o, "status") ?: "kept", int(o, "maxId"),
        strings(o, "classes"), strings(o, "chapters"),
        bool(o, "agent"), str(o, "risk"), str(o, "reason"),
    )

    private fun module(o: JsonObject) = ChangeMapModule(
        str(o, "module") ?: "", str(o, "label") ?: "", int(o, "churn"), int(o, "cnt"),
        int(o, "kept"), int(o, "pending"), int(o, "undone"), str(o, "status") ?: "kept",
        int(o, "files"), strings(o, "chapters"),
    )
}
