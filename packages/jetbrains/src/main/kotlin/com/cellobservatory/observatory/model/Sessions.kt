package com.cellobservatory.observatory.model

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's session listing, parsed from `claude-observatory sessions --json` (0.8.8).
 *
 * The listing is deliberately CHEAP: core builds it from directory stats plus a bounded, sidecar-cached
 * title scan — it never parses a session's edit log, so no row carries a pending count. Ordering is by
 * CONVERSATION recency ([lastActiveMs] = transcript mtime), not by store writes, so accepting a batch of
 * old edits cannot resurrect a dead session to the top of the list.
 */
data class SessionRow(
    val id: String,
    /** Claude's own title for the session (its ai-title, else its first prompt); blank when neither exists. */
    val title: String?,
    val lastActiveMs: Long,
    /** True for the session this workspace resolves to right now — the one still being written. */
    val current: Boolean,
    /** What the session did, in the terms the store's log carries: captured edits, how many still await
     *  review, and how many files they touched. Zero for a conversation that changed nothing. */
    val edits: Int,
    val pending: Int,
    val files: Int,
    /** Lines added / removed across the session's captured edits (0.9.0). Sidecar-cached in core against
     *  the log's stamp, so a row still costs a stat once a finished session has been counted once. */
    val added: Int = 0,
    val removed: Int = 0,
    /** Tokens the conversation consumed and its wall-clock span — the same pair a fleet row shows. */
    val tokens: Long = 0,
    val durationMs: Long = 0,
    /** What it ran on, as recorded by the harness: display label ("Opus 5") and declared reasoning effort.
     *  Blank when the transcript never said — an unset effort is reported as unknown, never guessed, since
     *  the default differs by build and model. Older CLIs emit neither field and simply show nothing. */
    val model: String = "",
    val effort: String = "",
) {
    /** What a row leads with: Claude's title, else a short id (never an empty label). */
    val displayName: String get() = title?.takeIf { it.isNotBlank() } ?: "session ${id.take(8)}"
}

/** [active] is the auto-resolved session id for this workspace (null when the workspace has none). */
data class SessionsResult(val active: String?, val sessions: List<SessionRow>)

object SessionsParser {
    /**
     * Parse `sessions --json`, or null when the CLI on PATH predates 0.8.8.
     *
     * The old shape carried `edits`/`pending`/`lastMs` and no `lastActiveMs`. Coercing those missing
     * fields to 0/false would fabricate a listing: every row "last active at the epoch", none of them
     * live, ordered by nothing. Returning null instead lets both surfaces fall back honestly — the tab
     * says the CLI could not answer, and the popup lists ids from the in-process store reader.
     */
    fun parse(json: String): SessionsResult? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val arr = o.getAsJsonArray("sessions") ?: JsonArray()
        val rows = arr.mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject }
        if (rows.any { !it.has("lastActiveMs") }) null // pre-0.8.8 payload — refuse it rather than invent times
        else SessionsResult(
            active = o.get("active")?.takeIf { it.isJsonPrimitive }?.asString,
            sessions = rows.map(::row),
        )
    } catch (_: Exception) {
        null
    }

    private fun row(o: JsonObject) = SessionRow(
        id = o.get("id")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
        title = o.get("title")?.takeIf { it.isJsonPrimitive }?.asString?.takeIf { it.isNotBlank() },
        lastActiveMs = o.get("lastActiveMs")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
        current = o.get("current")?.takeIf { it.isJsonPrimitive }?.asBoolean ?: false,
        edits = o.get("edits")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        pending = o.get("pending")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        files = o.get("files")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        // 0.9.0 badge fields. Absent on an older CLI, and 0/"" is the honest reading of absent here —
        // unlike `lastActiveMs` above, a missing count says "this build does not report it", which the
        // renderer shows by omitting the badge rather than by drawing a zero.
        added = o.get("added")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        removed = o.get("removed")?.takeIf { it.isJsonPrimitive }?.asInt ?: 0,
        tokens = o.get("tokens")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
        durationMs = o.get("durationMs")?.takeIf { it.isJsonPrimitive }?.asLong ?: 0L,
        model = o.get("model")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
        effort = o.get("effort")?.takeIf { it.isJsonPrimitive }?.asString ?: "",
    )
}
