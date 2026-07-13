package com.cellobservatory.observatory.model

import com.google.gson.JsonParser

/** One tool call Claude made (mirrors core's ActionRecord over the CLI `actions --json` surface). */
data class ActionRecord(
    val ts: Long,
    val tool: String,
    val category: String,
    val target: String,
    val detail: String?,
    val ok: Boolean,
    val isError: Boolean,
    val reasoning: String?,
    val editId: Int?,
)

/** A category group in the Actions timeline (mirrors core's ActionGroup). */
data class ActionGroup(
    val category: String,
    val label: String,
    val count: Int,
    val errors: Int,
    val actions: List<ActionRecord>,
)

data class ActionsResult(val session: String, val total: Int, val errors: Int, val groups: List<ActionGroup>)

/** Parse the `claude-observatory actions --json` payload (which already carries the grouped view-model). */
object ActionsParser {
    fun parse(json: String): ActionsResult? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val summary = o.getAsJsonObject("summary")
        val groups = o.getAsJsonArray("groups").map { g ->
            val go = g.asJsonObject
            ActionGroup(
                category = go.get("category").asString,
                label = go.get("label").asString,
                count = go.get("count").asInt,
                errors = go.get("errors").asInt,
                actions = go.getAsJsonArray("actions").map { a ->
                    val ao = a.asJsonObject
                    fun strOrNull(k: String) = ao.get(k)?.takeIf { !it.isJsonNull }?.asString
                    ActionRecord(
                        ts = ao.get("ts")?.takeIf { !it.isJsonNull }?.asLong ?: 0L,
                        tool = ao.get("tool")?.asString ?: "",
                        category = ao.get("category")?.asString ?: "other",
                        target = ao.get("target")?.asString ?: "",
                        detail = strOrNull("detail"),
                        ok = ao.get("ok")?.asBoolean ?: true,
                        isError = ao.get("isError")?.asBoolean ?: false,
                        reasoning = strOrNull("reasoning"),
                        editId = ao.get("editId")?.takeIf { !it.isJsonNull }?.asInt,
                    )
                },
            )
        }
        ActionsResult(
            session = o.get("session")?.asString ?: "",
            total = summary?.get("total")?.asInt ?: 0,
            errors = summary?.get("errors")?.asInt ?: 0,
            groups = groups,
        )
    } catch (_: Exception) {
        null
    }
}
