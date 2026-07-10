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
            {"folders":[{"label":"src","folders":[],"files":[
              {"rel":"src/a.ts","file":"/w/src/a.ts","classes":[
                {"name":"Foo","edits":[{"id":1,"ts":1000,"tool":"Edit","file":"/w/src/a.ts","beforeBlob":"aa","afterBlob":"bb","status":"pending","added":3,"removed":1}]}
              ],"loose":[{"id":2,"ts":2000,"tool":"Write","file":"/w/src/a.ts","beforeBlob":null,"afterBlob":"cc","status":"kept","added":5,"removed":0}]}
            ]}],"files":[]}
        """.trimIndent()
        val tree = TreeParser.parse(json)!!
        assertEquals(1, tree.folders.size)
        val folder = tree.folders[0]
        assertEquals("src", folder.label)
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
        assertTrue(p.suggestions.isEmpty())
        assertTrue(p.edits.isEmpty())
    }
}
