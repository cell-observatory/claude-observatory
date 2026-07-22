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
    /** Stable brush key AND the WYSIWYG review-op key: ✓/↩/🧹 resolve via core.reviewEditIds(id) —
     *  exactly the edits the row displays, the synthetic session chapter included. */
    val id: String,
    /** The STRICT task this chapter joins for analytics + 💬 chat framing; null = no strict task (the
     *  synthetic session chapter, or a duplicate-content occurrence beyond the first). 0.8.0 chapters
     *  are TOTAL — no "unassigned" row exists; work outside any to-do lands in the synthetic chapter. */
    val taskId: String?,
    /** True for the fallback session chapter that claims work outside any to-do. */
    val synthetic: Boolean,
    /** True when born from the numbered task list (0.8.3) — the Tasks tab is its home; the ribbon
     *  never draws it (attribution, review, and the tab's count join still use it). */
    val fromTask: Boolean,
    val index: Int,
    val title: String,
    /** "done" | "wip" | "todo" — from Claude's own to-do status. */
    val status: String,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val kept: Int,
    val pending: Int,
    val undone: Int,
    val agent: Boolean,
    /** Raw store edit ids DISPLAYED under this chapter, in capture order — the model the nav-bar CHAPTER
     *  axis walks (mirrors core.chapterEditIds exactly). Empty for a planned zero-edit / duplicate row,
     *  and for a workflow-slice chapter (core zeroes it there — the axis only reads the session's own). */
    val editIds: List<Int>,
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
    /** Human-readable session name (Claude's ai-title, else the first user prompt; blank when neither) —
     *  the Overview session selector + the Stats panel show this instead of the raw id. */
    val title: String?,
    val units: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
    /** ±lines across the slice (headline counts; chapters are total, so no residual math needs these). */
    val added: Int,
    val removed: Int,
    val errors: Int,
    val subagents: Int,
    /** Sibling sessions in this project (the 🛰 chip) — same headline the VS Code panel shows. */
    val fleet: Int,
    /** Off-machine destinations this session reached (the ⇅ chip). */
    val egress: Int,
)

/** One in/out-of-workspace file-touch tally from `capabilities` (core.CapabilityBadge). [samples] are up
 *  to three example out-of-root paths, already home-shortened by core — shown in the badge's tooltip. */
data class CapabilityBadge(val count: Int, val outOfRoot: Int, val samples: List<String>)

/**
 * What a session actually REACHED FOR (core.buildCapabilities): the files it read and edited and how many
 * landed outside the workspace, the shell commands it ran and their risk tiers, MCP servers, web hosts,
 * subagents spawned.
 *
 * EXERCISED capability, never granted permission — Claude Code writes nothing to the transcript when it
 * prompts for approval, so no read-only observer can tell auto-approved from human-waved-through. Every
 * label this drives must therefore say what the session DID, never what it was allowed to do.
 */
data class Capabilities(
    val reads: CapabilityBadge,
    val edits: CapabilityBadge,
    val execCount: Int,
    val execRisky: Int,
    val execHigh: Int,
    val mcpCalls: Int,
    val mcpServers: List<String>,
    val webCalls: Int,
    val webHosts: List<String>,
    val agentSpawns: Int,
) {
    /** True when the session exercised anything at all — the badge row hides itself otherwise. */
    val any: Boolean
        get() = reads.count > 0 || edits.count > 0 || execCount > 0 || mcpCalls > 0 || webCalls > 0 || agentSpawns > 0
}

/**
 * One context compaction, placed in the chapter whose window CONTAINS it (core.CompactionMarker).
 * [label] is core's one-line summary ("auto · 1M→14k · 986k dropped · 2m 5s") — rendered VERBATIM, never
 * re-derived, so both editors word a compaction identically. [afterChapterId] is null when the session
 * had no chapter windows at all; a renderer whose anchor chapter isn't drawn clamps the marker rather
 * than dropping it.
 */
data class CompactBoundary(
    val ts: Long,
    val trigger: String,
    val droppedTokens: Long,
    /** The harness's running session total ("dropped so far"), not this event's own drop. */
    val cumulativeDropped: Long,
    val durationMs: Long,
    val label: String,
    val afterChapterId: String?,
)

/**
 * Parse a `capabilities` block. Shared by [ChangeMapParser] and MultitaskParser — `changemap --json` and
 * the `multitask --json` fleet rows carry the identical block. Deliberately total: a partial or foreign
 * block yields zeros instead of throwing, because an exception here would null the WHOLE payload and
 * blank the Overview for anyone on an older CLI.
 */
internal fun parseCapabilities(o: JsonObject): Capabilities {
    fun obj(k: String): JsonObject? = o.get(k)?.takeIf { it.isJsonObject }?.asJsonObject
    fun i(x: JsonObject?, k: String): Int = x?.get(k)?.takeIf { !it.isJsonNull }?.asInt ?: 0
    fun ss(x: JsonObject?, k: String): List<String> =
        (x?.get(k)?.takeIf { it.isJsonArray }?.asJsonArray ?: com.google.gson.JsonArray())
            .mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asString }
    fun badge(k: String): CapabilityBadge {
        val b = obj(k)
        return CapabilityBadge(i(b, "count"), i(b, "outOfRoot"), ss(b, "samples"))
    }
    val exec = obj("exec")
    val mcp = obj("mcp")
    val web = obj("web")
    val agents = obj("agents")
    return Capabilities(
        reads = badge("reads"),
        edits = badge("edits"),
        execCount = i(exec, "count"), execRisky = i(exec, "risky"), execHigh = i(exec, "high"),
        mcpCalls = i(mcp, "calls"), mcpServers = ss(mcp, "servers"),
        webCalls = i(web, "calls"), webHosts = ss(web, "hosts"),
        agentSpawns = i(agents, "spawns"),
    )
}

/** A stable-id task (0.8.0) — content-hash identity spanning strict in-progress intervals. The Overview
 *  ribbon is built from these, JOINED to [TaskRoll] by [taskId] (NOT keyed off chapters). */
data class ChangeMapTask(
    val taskId: String,
    val content: String,
    val firstTs: Long,
    val lastTs: Long,
)

/** Per-task change rollup (0.8.0). [taskId] == null is the explicit "unassigned" bucket — edits that
 *  fell in no strict in-progress interval, never swept into a neighbouring task. */
data class TaskRoll(
    val taskId: String?,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
)

/** Per-subagent change rollup (0.8.0). [subagentId] == null = main-chain or unattributed. */
data class SubagentRoll(
    val subagentId: String?,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
)

/** Per-workflow change rollup (0.8.0 r2). [workflowId] == null = no-workflow / main-chain / ambiguous. */
data class WorkflowRoll(
    val workflowId: String?,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
)

/** One workflow's aggregate rollup (mirrors core ChangeMapWorkflow.rollup — the per-workflow Overview tab). */
data class WorkflowRollup(
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
)

/** One workflow's Overview TAB (0.8.0 r2): its ts-window-attributed edits rolled up + its touched files.
 *  [taskIds] are the distinct non-null tasks this workflow contributed to (the tab's informational ribbon). */
data class ChangeMapWorkflow(
    val id: String,
    val name: String,
    val running: Boolean,
    val rollup: WorkflowRollup,
    val files: List<ChangeMapFile>,
    val taskIds: List<String>,
    /** The run's edits regrouped by session chapter (counts scoped to the run) — rendered as the
     *  workflow slice's ribbon as-is; total chapters made the residual "unassigned" math obsolete. */
    val chapters: List<ChangeMapChapter>,
)

/** Per-agent (session) change rollup (0.8.0), worktree-aware. */
data class AgentRoll(
    val session: String,
    val edits: Int,
    val added: Int,
    val removed: Int,
    val pending: Int,
    val kept: Int,
    val undone: Int,
    val files: Int,
)

/** One agent's full change-map build (0.8.0) — the per-agent Overview TAB. Carries top-level
 *  session/worktree/gitBranch/phase for the tab label, plus its own summary/files/modules/tasks and
 *  rollups (each a per-sibling `buildChangeMap` aggregated once in core). */
data class ChangeMapAgent(
    val session: String,
    val worktree: String,
    val gitBranch: String,
    val phase: String,
    val summary: ChangeMapSummary?,
    val chapters: List<ChangeMapChapter>,
    val files: List<ChangeMapFile>,
    val modules: List<ChangeMapModule>,
    val tasks: List<ChangeMapTask>,
    val rollupByTask: List<TaskRoll>,
    val rollupBySubagent: List<SubagentRoll>,
    /** This agent's context compactions, oldest first — empty for an older CLI without the field. */
    val compactions: List<CompactBoundary>,
    /** What this agent reached for — null for an older CLI without the field (the badge row hides). */
    val capabilities: Capabilities?,
)

data class ChangeMap(
    val summary: ChangeMapSummary?,
    val chapters: List<ChangeMapChapter>,
    val files: List<ChangeMapFile>,
    val modules: List<ChangeMapModule>,
    // 0.8.0 additions — the three-level attribution + per-agent tabs.
    val tasks: List<ChangeMapTask>,
    val rollupByTask: List<TaskRoll>,
    val rollupBySubagent: List<SubagentRoll>,
    val rollupByAgent: List<AgentRoll>,
    val agents: List<ChangeMapAgent>,
    /** The session-wide unassigned bucket (edits outside every strict in-progress interval). */
    val unassigned: TaskRoll?,
    /** Per-workflow rollup, incl. the `workflowId: null` no-workflow/ambiguous bucket. */
    val rollupByWorkflow: List<WorkflowRoll>,
    /** One entry per workflow that produced attributed edits — the Overview's per-workflow tabs. */
    val workflows: List<ChangeMapWorkflow>,
    /** Context compactions during this session, oldest first — the ribbon draws one marker per boundary,
     *  positioned by [CompactBoundary.afterChapterId]. Empty for an older CLI without the field. */
    val compactions: List<CompactBoundary>,
    /** What this session reached for — null for an older CLI without the field (the badge row hides). */
    val capabilities: Capabilities?,
)

object ChangeMapParser {
    fun parse(json: String): ChangeMap? = try {
        val o = JsonParser.parseString(json).asJsonObject
        ChangeMap(
            o.getAsJsonObject("summary")?.let { summary(it) },
            arr(o, "chapters").map { chapter(it.asJsonObject) },
            arr(o, "files").map { file(it.asJsonObject) },
            arr(o, "modules").map { module(it.asJsonObject) },
            arr(o, "tasks").map { task(it.asJsonObject) },
            arr(o, "rollupByTask").map { taskRoll(it.asJsonObject) },
            arr(o, "rollupBySubagent").map { subagentRoll(it.asJsonObject) },
            arr(o, "rollupByAgent").map { agentRoll(it.asJsonObject) },
            arr(o, "agents").map { agent(it.asJsonObject) },
            o.getAsJsonObject("unassigned")?.let { taskRoll(it) },
            arr(o, "rollupByWorkflow").map { workflowRoll(it.asJsonObject) },
            arr(o, "workflows").map { workflow(it.asJsonObject) },
            arr(o, "compactions").map { compaction(it.asJsonObject) },
            o.get("capabilities")?.takeIf { it.isJsonObject }?.asJsonObject?.let { parseCapabilities(it) },
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
        str(o, "title"),
        int(o, "units"), int(o, "pending"), int(o, "kept"), int(o, "undone"),
        int(o, "added"), int(o, "removed"),
        int(o, "errors"), int(o, "subagents"), int(o, "fleet"), int(o, "egress"),
    )

    private fun ints(o: JsonObject, k: String): List<Int> =
        (o.getAsJsonArray(k) ?: com.google.gson.JsonArray()).mapNotNull { it.takeIf { e -> !e.isJsonNull }?.asInt }

    private fun chapter(o: JsonObject) = ChangeMapChapter(
        str(o, "id") ?: "",
        // Version-skew tolerance: an older CLI has no `taskId` key — there, chapter.id WAS the strict
        // taskId, so fall back to it. An explicit JSON null (synthetic/duplicate row) must stay null.
        if (o.has("taskId")) str(o, "taskId") else str(o, "id"),
        bool(o, "synthetic"),
        bool(o, "fromTask"),
        int(o, "index"), str(o, "title") ?: "", str(o, "status") ?: "todo",
        int(o, "edits"), int(o, "added"), int(o, "removed"),
        int(o, "kept"), int(o, "pending"), int(o, "undone"), bool(o, "agent"),
        ints(o, "editIds"),
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

    private fun long(o: JsonObject, k: String): Long =
        o.get(k)?.takeIf { !it.isJsonNull }?.asLong ?: 0L

    private fun task(o: JsonObject) = ChangeMapTask(
        str(o, "taskId") ?: "", str(o, "content") ?: "", long(o, "firstTs"), long(o, "lastTs"),
    )

    private fun compaction(o: JsonObject) = CompactBoundary(
        ts = long(o, "ts"),
        trigger = str(o, "trigger") ?: "compact",
        droppedTokens = long(o, "droppedTokens"),
        cumulativeDropped = long(o, "cumulativeDropped"),
        durationMs = long(o, "durationMs"),
        // core builds this line once (compactLabel) so both editors word a compaction identically; an
        // older CLI without it degrades to the bare trigger rather than to a blank row.
        label = str(o, "label") ?: (str(o, "trigger") ?: "compact"),
        afterChapterId = str(o, "afterChapterId"),
    )

    private fun taskRoll(o: JsonObject) = TaskRoll(
        str(o, "taskId"), int(o, "edits"), int(o, "added"), int(o, "removed"),
        int(o, "pending"), int(o, "kept"), int(o, "undone"),
    )

    private fun subagentRoll(o: JsonObject) = SubagentRoll(
        str(o, "subagentId"), int(o, "edits"), int(o, "added"), int(o, "removed"),
        int(o, "pending"), int(o, "kept"), int(o, "undone"),
    )

    private fun workflowRoll(o: JsonObject) = WorkflowRoll(
        str(o, "workflowId"), int(o, "edits"), int(o, "added"), int(o, "removed"),
        int(o, "pending"), int(o, "kept"), int(o, "undone"),
    )

    private fun workflow(o: JsonObject): ChangeMapWorkflow {
        val r = o.getAsJsonObject("rollup")
        return ChangeMapWorkflow(
            id = str(o, "id") ?: "",
            name = str(o, "name") ?: "workflow",
            running = bool(o, "running"),
            rollup = WorkflowRollup(
                r?.let { int(it, "edits") } ?: 0, r?.let { int(it, "added") } ?: 0, r?.let { int(it, "removed") } ?: 0,
                r?.let { int(it, "pending") } ?: 0, r?.let { int(it, "kept") } ?: 0, r?.let { int(it, "undone") } ?: 0,
            ),
            files = arr(o, "files").map { file(it.asJsonObject) },
            taskIds = strings(o, "taskIds"),
            chapters = arr(o, "chapters").map { chapter(it.asJsonObject) },
        )
    }

    private fun agentRoll(o: JsonObject) = AgentRoll(
        str(o, "session") ?: "", int(o, "edits"), int(o, "added"), int(o, "removed"),
        int(o, "pending"), int(o, "kept"), int(o, "undone"), int(o, "files"),
    )

    private fun agent(o: JsonObject) = ChangeMapAgent(
        session = str(o, "session") ?: "",
        worktree = str(o, "worktree") ?: "",
        gitBranch = str(o, "gitBranch") ?: "",
        phase = str(o, "phase") ?: "idle",
        summary = o.getAsJsonObject("summary")?.let { summary(it) },
        chapters = arr(o, "chapters").map { chapter(it.asJsonObject) },
        files = arr(o, "files").map { file(it.asJsonObject) },
        modules = arr(o, "modules").map { module(it.asJsonObject) },
        tasks = arr(o, "tasks").map { task(it.asJsonObject) },
        rollupByTask = arr(o, "rollupByTask").map { taskRoll(it.asJsonObject) },
        rollupBySubagent = arr(o, "rollupBySubagent").map { subagentRoll(it.asJsonObject) },
        compactions = arr(o, "compactions").map { compaction(it.asJsonObject) },
        capabilities = o.get("capabilities")?.takeIf { it.isJsonObject }?.asJsonObject?.let { parseCapabilities(it) },
    )
}

/**
 * Kotlin mirror of core.moduleLabel — the change-map's module-bucket display label: '' → '(root)', an
 * out-of-workspace path → '(external)', else strip the monorepo noise (a `packages/` prefix and a trailing
 * `/src`). Kept here (not re-derived per surface) so the JetBrains Folder axis and the strip tiles agree
 * on one identity, exactly as the VS Code webview does.
 */
fun moduleLabel(module: String): String {
    if (module.isEmpty()) return "(root)"
    if (module.startsWith("..")) return "(external)"
    var s = module
    if (s.startsWith("packages/")) s = s.substring("packages/".length)
    if (s.endsWith("/src")) s = s.substring(0, s.length - "/src".length)
    return s
}

/**
 * A file's "folder" — the change-map module-bucket LABEL of its immediate parent dir (`(root)`,
 * `(external)`, or the relative dir). Mirrors the VS Code `folderLabelOf`, so a Folder-axis position and a
 * strip tile share one identity. [root] is the workspace root; [file] is an absolute path.
 */
fun folderLabelOf(file: String, root: String?): String {
    val relDir: String = if (root != null && root.isNotBlank()) {
        val rp = java.io.File(root).absoluteFile.toPath()
        val fp = java.io.File(file).absoluteFile.toPath()
        val rel = try {
            rp.relativize(fp).toString().replace(java.io.File.separatorChar, '/')
        } catch (_: Exception) {
            file.replace(java.io.File.separatorChar, '/') // cross-root (e.g. different drive) → treat as external below
        }
        val slash = rel.lastIndexOf('/')
        if (slash >= 0) rel.substring(0, slash) else "" // dirname; a bare basename → root file
    } else {
        val norm = file.replace(java.io.File.separatorChar, '/')
        val slash = norm.lastIndexOf('/')
        if (slash >= 0) norm.substring(0, slash) else ""
    }
    return moduleLabel(relDir)
}
