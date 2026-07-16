package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's Observations view-model, parsed from `claude-observatory observations --json`
 * (0.8.0 — the folded Timeline+Observations view). A session recap on top, the edit timeline as coalesced
 * same-file ×N runs (most-recent first) each edit carrying Claude's own reasoning, and the still-open next
 * steps at the end. Every field is assembled in core — this plugin only paints, so VS Code and JetBrains
 * can never disagree.
 */

/** One edit inside a coalesced run — its ±lines, review status, and Claude's reasoning for it. */
data class ObservationEdit(
    val id: Int,
    val ts: Long,
    val added: Int,
    val removed: Int,
    val status: String, // pending | kept | undone
    val reasoning: String?, // Claude's own words for this edit, null when uncorrelated
)

/** A run of adjacent same-file edits — the timeline's ×N unit, with a combined delta. */
data class ObservationRun(
    val file: String, // absolute path
    val rel: String, // root-relative, forward slashes
    val count: Int,
    val added: Int,
    val removed: Int,
    val status: String, // worst-unreviewed-wins rollup (pending > undone > kept)
    val edits: List<ObservationEdit>, // chronological order (expand for per-edit Keep/Undo)
)

data class Observations(
    val recap: String,
    val runs: List<ObservationRun>, // most-recent activity first
    val nextSteps: List<String>,
)

object ObservationsParser {
    fun parse(json: String): Observations? = try {
        val o = JsonParser.parseString(json).asJsonObject
        Observations(
            recap = o.get("recap")?.takeIf { !it.isJsonNull }?.asString ?: "",
            runs = arr(o, "runs").map { run(it.asJsonObject) },
            nextSteps = arr(o, "nextSteps").mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString },
        )
    } catch (_: Exception) {
        null
    }

    private fun arr(o: JsonObject, k: String) = o.getAsJsonArray(k) ?: com.google.gson.JsonArray()
    private fun str(o: JsonObject, k: String): String? = o.get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun int(o: JsonObject, k: String): Int = o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0
    private fun long(o: JsonObject, k: String): Long = o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L

    private fun run(o: JsonObject) = ObservationRun(
        file = str(o, "file") ?: "",
        rel = str(o, "rel") ?: "",
        count = int(o, "count"),
        added = int(o, "added"),
        removed = int(o, "removed"),
        status = str(o, "status") ?: "kept",
        edits = arr(o, "edits").map { edit(it.asJsonObject) },
    )

    private fun edit(o: JsonObject) = ObservationEdit(
        id = int(o, "id"),
        ts = long(o, "ts"),
        added = int(o, "added"),
        removed = int(o, "removed"),
        status = str(o, "status") ?: "pending",
        reasoning = str(o, "reasoning"),
    )
}
