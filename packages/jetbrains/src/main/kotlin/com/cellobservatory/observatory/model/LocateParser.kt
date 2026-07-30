package com.cellobservatory.observatory.model

import com.google.gson.JsonParser

/**
 * Kotlin mirror of core's `locate --json` payload: where each pending edit lands in the LIVE buffer.
 *
 * Split out of `ObservatoryCli.locate` so the payload contract is unit-testable without spawning a CLI —
 * this is the reader the architecture doc's "the Kotlin reader must never drift" rule is about.
 *
 * Every field beyond `id`/`lines` is OPTIONAL by design, in both directions:
 *   - a pre-0.10 CLI emits neither `removed` nor `delta`, and must still parse (the plugin then renders
 *     what it always did: added lines, no ghost text, no churn in the lens);
 *   - even a current CLI omits `delta` for a placement that renders nothing, since computing it costs a
 *     whole-file diff per record.
 * A malformed entry is SKIPPED rather than thrown, so one bad hunk cannot blank a file's whole overlay.
 */
object LocateParser {
    fun parse(stdout: String): List<Placement> = try {
        JsonParser.parseString(stdout).asJsonObject.getAsJsonArray("placements").mapNotNull { el ->
            val o = el.asJsonObject
            val id = o.get("id")?.takeIf { it.isJsonPrimitive }?.asInt ?: return@mapNotNull null
            val lines = o.getAsJsonArray("lines")?.mapNotNull { n -> n.takeIf { it.isJsonPrimitive }?.asInt } ?: emptyList()
            Placement(id, lines, deletions(o), delta(o))
        }
    } catch (_: Exception) {
        emptyList()
    }

    private fun deletions(o: com.google.gson.JsonObject): List<Deletion> {
        val arr = o.get("removed")?.takeIf { it.isJsonArray }?.asJsonArray ?: return emptyList()
        return arr.mapNotNull { el ->
            val d = el.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
            val anchor = d.get("anchor")?.takeIf { it.isJsonPrimitive }?.asInt ?: return@mapNotNull null
            val text = d.get("lines")?.takeIf { it.isJsonArray }?.asJsonArray
                ?.mapNotNull { n -> n.takeIf { it.isJsonPrimitive }?.asString } ?: emptyList()
            if (text.isEmpty()) null else Deletion(anchor, text)
        }
    }

    private fun delta(o: com.google.gson.JsonObject): Delta? {
        val d = o.get("delta")?.takeIf { it.isJsonObject }?.asJsonObject ?: return null
        val added = d.get("added")?.takeIf { it.isJsonPrimitive }?.asInt ?: return null
        val removed = d.get("removed")?.takeIf { it.isJsonPrimitive }?.asInt ?: return null
        return Delta(added, removed)
    }
}
