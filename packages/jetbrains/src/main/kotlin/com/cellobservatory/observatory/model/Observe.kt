package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** One row of the Observations view — the CLI `observe --json` per-edit shape. */
data class ObsEdit(
    val id: Int,
    val ts: Long,
    val tool: String,
    val file: String,
    val status: String,
    val summary: String,
    val reasoning: String?,
    val flags: List<ObsFlag>,
    val memorySummary: String,
    val risky: Boolean,
    val analysis: String?,
)

data class ObsFlag(val level: String, val message: String)

data class ObservePayload(
    val session: String,
    val recap: String?,
    val suggestions: List<String>,
    val edits: List<ObsEdit>, // newest-first, as emitted by the CLI
)

object ObserveParser {
    fun parse(json: String): ObservePayload? = try {
        val o = JsonParser.parseString(json).asJsonObject
        ObservePayload(
            session = o.get("session").asString,
            recap = o.get("recap")?.takeIf { !it.isJsonNull }?.asString,
            suggestions = o.getAsJsonArray("suggestions")?.map { it.asString } ?: emptyList(),
            edits = o.getAsJsonArray("edits")?.map { parseEdit(it.asJsonObject) } ?: emptyList(),
        )
    } catch (_: Exception) {
        null
    }

    private fun parseEdit(e: JsonObject): ObsEdit = ObsEdit(
        id = e.get("id").asInt,
        ts = e.get("ts")?.takeIf { !it.isJsonNull }?.asLong ?: 0L,
        tool = e.get("tool")?.takeIf { !it.isJsonNull }?.asString ?: "",
        file = e.get("file").asString,
        status = e.get("status")?.takeIf { !it.isJsonNull }?.asString ?: "pending",
        summary = e.get("summary")?.takeIf { !it.isJsonNull }?.asString ?: "",
        reasoning = e.get("reasoning")?.takeIf { !it.isJsonNull }?.asString,
        flags = e.getAsJsonArray("flags")?.map {
            val f = it.asJsonObject
            ObsFlag(f.get("level")?.asString ?: "info", f.get("message")?.asString ?: "")
        } ?: emptyList(),
        memorySummary = e.getAsJsonObject("memory")?.get("summary")?.takeIf { !it.isJsonNull }?.asString ?: "",
        risky = e.getAsJsonObject("memory")?.get("risky")?.takeIf { !it.isJsonNull }?.asBoolean ?: false,
        analysis = e.get("analysis")?.takeIf { !it.isJsonNull }?.asString,
    )
}
