package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Parity pin for [MultitaskFilter] — the SAME fixture the VS Code smoke test drives through the
 * canonical `multitaskFilter` (extension.ts / smoke.test.js `mtPayload`), so the two editors can never
 * drift on what "active", "completed", and "dismissed" mean:
 *   aw(working) · ap(awaiting-permission) · idleSub(idle, live subagent) = ACTIVE;
 *   done1(done) · idle1(idle, done subagent) · err1(errored) = COMPLETED;
 *   wfRun(running) · wfDone(finished).
 */
class MultitaskFilterTest {

    private fun payload(): MultitaskResult {
        val json = """
            {"agents":[
               {"session":"aw","worktree":"/w","gitBranch":"main","self":true,"phase":"working","sparkline":[],"todos":[],"subagents":[],"files":[],"diff":{"added":0,"removed":0},"tokens":0,"durationMs":0,"risk":{"total":0,"high":0}},
               {"session":"ap","worktree":"/w","gitBranch":"main","self":false,"phase":"awaiting-permission","sparkline":[],"todos":[],"subagents":[],"files":[],"diff":{"added":0,"removed":0},"tokens":0,"durationMs":0,"risk":{"total":0,"high":0}},
               {"session":"idleSub","worktree":"/w","gitBranch":"main","self":false,"phase":"idle","sparkline":[],"todos":[],
                "subagents":[{"agentId":"s1","agentType":null,"description":null,"phase":"working","todos":[],"currentTask":null,"edits":0,"added":0,"removed":0}],
                "files":[],"diff":{"added":0,"removed":0},"tokens":0,"durationMs":0,"risk":{"total":0,"high":0}},
               {"session":"done1","worktree":"/w","gitBranch":"main","self":false,"phase":"done","sparkline":[],"todos":[],"subagents":[],"files":[],"diff":{"added":0,"removed":0},"tokens":0,"durationMs":0,"risk":{"total":0,"high":0}},
               {"session":"idle1","worktree":"/w","gitBranch":"main","self":false,"phase":"idle","sparkline":[],"todos":[],
                "subagents":[{"agentId":"s2","agentType":null,"description":null,"phase":"done","todos":[],"currentTask":null,"edits":0,"added":0,"removed":0}],
                "files":[],"diff":{"added":0,"removed":0},"tokens":0,"durationMs":0,"risk":{"total":0,"high":0}},
               {"session":"err1","worktree":"/w","gitBranch":"main","self":false,"phase":"errored","sparkline":[],"todos":[],"subagents":[],"files":[],"diff":{"added":0,"removed":0},"tokens":0,"durationMs":0,"risk":{"total":0,"high":0}}
             ],
             "collisions":[],
             "worktrees":[],
             "workflows":[
               {"id":"wfRun","name":"run","description":null,"phases":[],"agents":[],"phaseGroups":[],"running":true,"agentCount":0,"tokens":0,"durationMs":0,"edits":0,"added":0,"removed":0,"startedTs":0,"lastTs":0,"sparkline":[]},
               {"id":"wfDone","name":"done","description":null,"phases":[],"agents":[],"phaseGroups":[],"running":false,"agentCount":0,"tokens":0,"durationMs":0,"edits":0,"added":0,"removed":0,"startedTs":0,"lastTs":0,"sparkline":[]}
             ],
             "actions":{"groups":[],"egress":[]},
             "summary":{"active":3,"conflicts":0}}
        """.trimIndent()
        return MultitaskParser.parse(json)!!
    }

    @Test
    fun `classification matches the VS Code multitaskFilter — active, completed, promotion via live subagent`() {
        val res = payload()
        val active = res.agents.filter { MultitaskFilter.agentActive(it) }.map { it.session }
        assertEquals(listOf("aw", "ap", "idleSub"), active) // active = working + awaiting-permission + idle-with-a-live-subagent
        val completed = res.agents.filterNot { MultitaskFilter.agentActive(it) }.map { it.session }.sorted()
        assertEquals(listOf("done1", "err1", "idle1"), completed)
        assertEquals(listOf("wfDone"), res.workflows.filterNot { MultitaskFilter.workflowActive(it) }.map { it.id })
    }

    @Test
    fun `active-only hides the inactive outright`() {
        val res = payload()
        val shown = res.agents.filter { MultitaskFilter.showAgent(it, activeOnly = true, dismissed = emptySet()) }
        assertEquals(listOf("ap", "aw", "idleSub"), shown.map { it.session }.sorted())
        val wf = res.workflows.filter { MultitaskFilter.showWorkflow(it, activeOnly = true, dismissed = emptySet()) }
        assertEquals(listOf("wfRun"), wf.map { it.id })
    }

    @Test
    fun `clear-completed hides dismissed items only while inactive — they reappear once active again`() {
        val res = payload()
        val dAg = setOf("done1", "idle1", "err1")
        val dWf = setOf("wfDone")
        val shown = res.agents.filter { MultitaskFilter.showAgent(it, activeOnly = false, dismissed = dAg) }
        assertEquals(listOf("ap", "aw", "idleSub"), shown.map { it.session }.sorted())
        assertEquals(4, MultitaskFilter.hiddenCount(res, dAg, dWf)) // 3 agents + 1 workflow feed "N hidden · show all"
        // Revive: the dismissed agent goes active again → dismissal no longer bites.
        val revived = res.agents.first { it.session == "done1" }.copy(phase = "working")
        assertTrue(MultitaskFilter.showAgent(revived, activeOnly = false, dismissed = dAg))
        val revivedWf = res.workflows.first { it.id == "wfDone" }.copy(running = true)
        assertTrue(MultitaskFilter.showWorkflow(revivedWf, activeOnly = false, dismissed = dWf))
    }
}
