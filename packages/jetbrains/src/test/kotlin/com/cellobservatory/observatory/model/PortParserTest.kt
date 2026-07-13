package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Port-fidelity tests for the JSON parsers that consume the CLI's stable-by-name `--json` surface
 * (`tree --json`, `observe`). They deserialize by field name with silent catch/null fallbacks, so a
 * TS-side rename would silently null/drop data — these fixtures pin every field the plugin reads.
 */
class PortParserTest {

    @Test
    fun `TreeParser extracts folders, files, classes, loose edits and exact deltas`() {
        val json = """
            {"folders":[{"label":"src","path":"/w/src","folders":[],"files":[
              {"rel":"src/a.ts","file":"/w/src/a.ts","classes":[
                {"name":"Foo","edits":[{"id":1,"ts":1000,"tool":"Edit","file":"/w/src/a.ts","beforeBlob":"aa","afterBlob":"bb","status":"pending","added":3,"removed":1}]}
              ],"loose":[{"id":2,"ts":2000,"tool":"Write","file":"/w/src/a.ts","beforeBlob":null,"afterBlob":"cc","status":"kept","added":5,"removed":0}]}
            ]}],"files":[]}
        """.trimIndent()
        val tree = TreeParser.parse(json)!!
        assertEquals(1, tree.folders.size)
        val folder = tree.folders[0]
        assertEquals("src", folder.label)
        assertEquals("/w/src", folder.path) // drives the folder-scoped Accept/Revert/Clear actions
        assertEquals(listOf(1, 2), folder.allEdits.map { it.id }) // every descendant edit, for folder ops
        val file = folder.files[0]
        assertEquals("src/a.ts", file.rel)
        assertEquals("/w/src/a.ts", file.file)
        val classEdit = file.classes[0].edits[0]
        assertEquals("Foo", file.classes[0].name)
        assertEquals(1, classEdit.rec.id)
        assertEquals("Edit", classEdit.rec.tool)
        assertEquals(3, classEdit.added)
        assertEquals(1, classEdit.removed)
        val loose = file.loose[0]
        assertEquals(2, loose.rec.id)
        assertNull(loose.rec.beforeBlob) // JSON null -> null (new-file create)
        assertEquals("kept", loose.rec.status)
        assertEquals(5, loose.added)
        assertEquals(listOf(1, 2), file.allEdits.map { it.id }) // class-grouped + loose, for Undo-All
    }

    @Test
    fun `ObserveParser extracts session, recap, suggestions, and per-edit fields incl memory + flags`() {
        val json = """
            {"session":"s1","recap":"did stuff","insights":{"todos":[],"lastSummary":"ls","title":"t"},
             "suggestions":["do X","do Y"],
             "edits":[{"id":1,"ts":1000,"tool":"Edit","file":"/w/a.ts","status":"pending",
                       "summary":"edited a.ts (+3 -1)","reasoning":"because","flags":[{"level":"warn","message":"adds a debug statement"}],
                       "memory":{"summary":"2 kept","risky":true},"analysis":null}]}
        """.trimIndent()
        val p = ObserveParser.parse(json)!!
        assertEquals("s1", p.session)
        assertEquals("did stuff", p.recap)
        assertEquals("ls", p.insights?.lastSummary)
        assertEquals("t", p.insights?.title)
        assertEquals(listOf("do X", "do Y"), p.suggestions)
        val e = p.edits[0]
        assertEquals(1, e.id)
        assertEquals("edited a.ts (+3 -1)", e.summary)
        assertEquals("because", e.reasoning)
        assertEquals("warn", e.flags[0].level)
        assertEquals("adds a debug statement", e.flags[0].message)
        assertEquals("2 kept", e.memorySummary)
        assertTrue(e.risky)
        assertNull(e.analysis)
    }

    @Test
    fun `ObserveParser tolerates a null recap and empty edits`() {
        val p = ObserveParser.parse("""{"session":"s2","recap":null,"suggestions":[],"edits":[]}""")!!
        assertEquals("s2", p.session)
        assertNull(p.recap)
        assertNull(p.insights) // absent insights object -> null, not a crash
        assertTrue(p.suggestions.isEmpty())
        assertTrue(p.edits.isEmpty())
    }

    @Test
    fun `ActionsParser extracts category groups + action fields incl editId link and error`() {
        val json = """
            {"session":"s1","summary":{"total":3,"errors":1,"byCategory":{"edit":2,"read":1}},
             "groups":[
               {"category":"edit","label":"Edits","count":2,"errors":0,"actions":[
                  {"ts":1000,"tool":"Edit","category":"edit","target":"/w/a.ts","detail":null,"ok":true,"isError":false,"reasoning":"because","editId":7,"risk":{"level":"high","reasons":["recursive delete"]}}
               ]},
               {"category":"read","label":"Reads","count":5,"errors":1,"actions":[
                  {"ts":2000,"tool":"Read","category":"read","target":"/w/b.ts","ok":false,"isError":true,"editId":null}
               ]}
             ],
             "egress":[{"kind":"web","target":"api.example.com","scope":"remote","count":2}]}
        """.trimIndent()
        val res = ActionsParser.parse(json)!!
        assertEquals("s1", res.session)
        assertEquals(3, res.total)
        assertEquals(1, res.errors)
        assertEquals(2, res.groups.size)
        val edits = res.groups[0]
        assertEquals("edit", edits.category)
        assertEquals("Edits", edits.label)
        assertEquals(2, edits.count)
        val a = edits.actions[0]
        assertEquals("Edit", a.tool)
        assertEquals("/w/a.ts", a.target)
        assertEquals("because", a.reasoning)
        assertTrue(a.editId == 7) // links to a store record → double-click reviews it in the panel
        assertTrue(a.ok)
        // The "Reads" group leaked into curated output because it has an error; the errored row is flagged.
        val reads = res.groups[1]
        assertEquals(1, reads.errors)
        val err = reads.actions[0]
        assertTrue(err.isError)
        assertNull(err.editId) // non-edit action carries no store link
        // risk + egress (0.7.0) are parsed off the same --json surface
        assertEquals("high", a.risk?.level)
        assertEquals("recursive delete", a.risk?.reasons?.get(0))
        assertNull(err.risk) // absent risk -> null
        assertEquals(1, res.egress.size)
        assertEquals("api.example.com", res.egress[0].target)
        assertEquals("remote", res.egress[0].scope)
        assertEquals(2, res.egress[0].count)
    }

    @Test
    fun `ActionsParser extracts subagents (with metrics) and fleet siblings, defaulting empty when absent`() {
        val json = """
            {"session":"s1","summary":{"total":0,"errors":0,"byCategory":{}},"groups":[],"egress":[],
             "subagents":[
               {"agentId":"a1","agentType":"code-reviewer","description":"review diff","status":"completed",
                "ts":1000,"durationMs":300000,"tokens":45000,"toolUseCount":12,
                "actions":[{"ts":1100,"tool":"Read","category":"read","target":"/x.ts","ok":true,"isError":false,"editId":null},
                           {"ts":1200,"tool":"Grep","category":"search","target":"foo","ok":false,"isError":true,"editId":null}],
                "edits":0,"summary":{"total":2,"errors":1,"byCategory":{"read":1,"search":1},"firstTs":1100,"lastTs":1200}}],
             "subagentsSummary":{"count":1,"totalActions":2,"totalEdits":0,"totalDurationMs":300000,"totalTokens":45000,"errors":1},
             "fleet":[
               {"id":"self1","self":true,"active":true,"lastMs":2000,"edits":3,"pending":1,"files":["/a.ts"],"moreFiles":0,"risk":{"total":0,"high":0}},
               {"id":"sib1","self":false,"active":false,"lastMs":1500,"edits":2,"pending":2,"files":["/b.ts","/c.ts"],"moreFiles":1,"risk":{"total":2,"high":1}}],
             "fleetSummary":{"total":2,"active":1,"siblings":1,"pending":2}}
        """.trimIndent()
        val res = ActionsParser.parse(json)!!
        // subagents: metadata + metrics + nested action timeline
        assertEquals(1, res.subagents.size)
        val sa = res.subagents[0]
        assertEquals("a1", sa.agentId)
        assertEquals("code-reviewer", sa.agentType)
        assertEquals("review diff", sa.description)
        assertEquals(300000L, sa.durationMs) // per-subagent metrics from toolUseResult
        assertEquals(45000L, sa.tokens)
        assertEquals(12, sa.toolUseCount)
        assertEquals(2, sa.actions.size)
        assertEquals("Read", sa.actions[0].tool) // the subagent's own tool calls, nested
        assertTrue(sa.actions[1].isError)
        assertEquals(2, sa.totalActions)
        assertEquals(1, sa.errors)
        assertEquals(1, res.subagentsSummary?.count)
        assertEquals(300000L, res.subagentsSummary?.totalDurationMs)
        // fleet: sibling sessions with status / pending / files / risk
        assertEquals(2, res.fleet.size)
        val self = res.fleet.first { it.self }
        val sib = res.fleet.first { !it.self }
        assertTrue(self.active)
        assertEquals(2, sib.pending)
        assertEquals(listOf("/b.ts", "/c.ts"), sib.files)
        assertEquals(1, sib.moreFiles)
        assertEquals(2, sib.riskTotal)
        assertEquals(1, sib.riskHigh)
        assertEquals(1, res.fleetSummary?.siblings)
        // back-compat: a 0.6.x payload with no subagents/fleet keys still parses (empty, not a crash)
        val legacy = ActionsParser.parse("""{"session":"s","summary":{"total":0,"errors":0,"byCategory":{}},"groups":[],"egress":[]}""")!!
        assertTrue(legacy.subagents.isEmpty() && legacy.fleet.isEmpty())
        assertNull(legacy.subagentsSummary)
    }
}
