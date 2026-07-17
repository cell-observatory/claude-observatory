package com.cellobservatory.observatory.model

/** One captured Claude edit, as stored in log.jsonl (status already folded). */
data class EditRecord(
    val id: Int,
    val ts: Long,
    val tool: String,
    val file: String,
    val beforeBlob: String?,
    val afterBlob: String?,
    val status: String, // "pending" | "kept" | "undone"
) {
    val pending get() = status == "pending"
    val kept get() = status == "kept"
    val undone get() = status == "undone"
}

data class SessionInfo(val id: String, val edits: Int, val pending: Int, val lastMs: Long)

/** Structured result of `undo/redo --json` — front-ends branch on [status], never on prose. */
data class UndoResult(val ok: Boolean, val status: String, val message: String) {
    val conflict get() = status == "conflict"
}

/** One edit's current line indices in the live buffer, from `locate --json`. */
data class Placement(val id: Int, val lines: List<Int>)

/** Compact relative time — port of core's relTime ("5s ago", "12m ago", "3h ago", "2d ago"). */
fun relTime(ts: Long, now: Long = System.currentTimeMillis()): String {
    val s = ((now - ts) / 1000).coerceAtLeast(0)
    if (s < 60) return "${s}s ago"
    val m = s / 60
    if (m < 60) return "${m}m ago"
    val h = m / 60
    if (h < 24) return "${h}h ago"
    val d = h / 24
    if (d < 14) return "${d}d ago"
    if (d < 61) return "${d / 7}w ago"
    return "${(d / 30.44).toInt()}mo ago" // parity: core format.ts relTime
}
