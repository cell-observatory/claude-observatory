package com.cellobservatory.observatory.model

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's live-feed view-model, parsed from `claude-observatory feed --json`: what ONE
 * thing in the Overview is doing — an agent, a workflow run, a task, a background shell, or the session
 * itself — as a bounded tail of the file that thing writes as it works.
 */
data class FeedEntry(
    /** ms epoch; 0 for raw output lines, which carry no timestamp of their own. */
    val ts: Long,
    /** 'action' | 'output' | 'reasoning'. */
    val kind: String,
    /** The headline: a tool call, or one line of output. */
    val label: String,
    /** Secondary context — the tool's target, or which agent produced it. */
    val detail: String?,
    /** false when the call reported an error; null when not applicable. */
    val ok: Boolean?,
)

data class Feed(
    /** core's echo of the ref this feed answers — a renderer checks it before painting, so a tail that
     *  landed for the previously selected row can never be shown under the new one. */
    val kind: String,
    val id: String,
    /** What is being watched, ready to render as the pane's heading. */
    val title: String,
    val running: Boolean,
    /** What this feed IS, decided in core so both editors agree: 'live' — still writing, so follow it
     *  and keep polling; 'audit' — finished, so it is a RECORD of what happened, not a stream, and a
     *  renderer stops asking for it. */
    val mode: String,
    /** Chronological, OLDEST first — a feed reads downward, like a terminal. */
    val entries: List<FeedEntry>,
    /** How many older entries core dropped to honour the limit — said out loud, never swallowed. */
    val truncated: Int,
    /** Newest evidence seen (ms epoch, 0 when none) — a renderer shows this AGE rather than claiming
     *  realtime it cannot verify. */
    val lastTs: Long,
    /** Set when the feed can only be partial, and why — rendered instead of a blank pane. */
    val note: String?,
) {
    val live: Boolean get() = mode == "live"
}

object FeedParser {
    fun parse(json: String): Feed? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val ref = o.getAsJsonObject("ref")
        Feed(
            kind = ref?.let { str(it, "kind") } ?: "session",
            id = ref?.let { str(it, "id") } ?: "",
            title = str(o, "title") ?: "",
            running = bool(o, "running"),
            // Unknown/absent mode degrades to 'audit': a feed we can't confirm is live must not be
            // labelled live, and must not be polled forever.
            mode = str(o, "mode")?.takeIf { it == "live" } ?: "audit",
            entries = (o.getAsJsonArray("entries") ?: com.google.gson.JsonArray())
                .mapNotNull { it.takeIf { e -> e.isJsonObject }?.asJsonObject?.let(::entry) },
            truncated = int(o, "truncated"),
            lastTs = long(o, "lastTs"),
            note = str(o, "note"),
        )
    } catch (_: Exception) {
        null
    }

    private fun str(o: JsonObject, k: String): String? = o.get(k)?.takeIf { !it.isJsonNull }?.asString
    private fun int(o: JsonObject, k: String): Int = o.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0
    private fun long(o: JsonObject, k: String): Long = o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L
    private fun bool(o: JsonObject, k: String): Boolean = o.get(k)?.takeIf { !it.isJsonNull }?.asBoolean ?: false

    private fun entry(o: JsonObject) = FeedEntry(
        ts = long(o, "ts"),
        kind = str(o, "kind") ?: "action",
        label = str(o, "label") ?: "",
        detail = str(o, "detail"),
        // Absent = not applicable; only an explicit false marks a failure.
        ok = o.get("ok")?.takeIf { !it.isJsonNull }?.asBoolean,
    )
}
