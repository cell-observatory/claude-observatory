package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The `locate --json` reader is a PORT of a CLI contract, so its job is to keep working when the payload
 * is older, newer, or damaged. Every case here is one of those, because the alternative to parsing
 * defensively is a file whose whole inline overlay blanks on one malformed hunk.
 */
class LocateParserTest {
    @Test
    fun `parses the full 0_10_0 payload`() {
        val p = LocateParser.parse(
            """{"file":"/w/a.ts","placements":[
                 {"id":7,"lines":[3,4],"removed":[{"anchor":9,"lines":["old one","old two"]}],"delta":{"added":2,"removed":2}}]}"""
        )
        assertEquals(1, p.size)
        assertEquals(7, p[0].id)
        assertEquals(listOf(3, 4), p[0].lines)
        assertEquals(listOf(Deletion(9, listOf("old one", "old two"))), p[0].removed)
        assertEquals(Delta(2, 2), p[0].delta)
    }

    @Test
    fun `a pre-0_10_0 payload still parses, with the new fields empty`() {
        val p = LocateParser.parse("""{"file":"/w/a.ts","placements":[{"id":1,"lines":[0]}]}""")
        assertEquals(listOf(0), p[0].lines)
        assertTrue("no deletion hunks means no ghost text, not a crash", p[0].removed.isEmpty())
        assertNull("no delta means the lens keeps its pre-0.10 label", p[0].delta)
    }

    @Test
    fun `a placement that renders nothing carries no delta`() {
        // The CLI omits delta for an unplaced (superseded) edit — computing it costs a whole-file diff.
        val p = LocateParser.parse("""{"file":"/w/a.ts","placements":[{"id":4,"lines":[],"removed":[]}]}""")
        assertTrue(p[0].lines.isEmpty())
        assertNull(p[0].delta)
    }

    @Test
    fun `malformed entries are skipped, never thrown`() {
        val p = LocateParser.parse(
            """{"placements":[
                 {"lines":[1]},
                 {"id":2,"lines":[5],"removed":[{"lines":["no anchor"]},{"anchor":8,"lines":[]},{"anchor":9,"lines":["kept"]}],"delta":{"added":1}}]}"""
        )
        assertEquals("the id-less placement is dropped", 1, p.size)
        assertEquals(2, p[0].id)
        assertEquals(
            "an anchor-less and an empty hunk are dropped; the good one survives",
            listOf(Deletion(9, listOf("kept"))),
            p[0].removed
        )
        assertNull("a half-written delta is no delta", p[0].delta)
    }

    @Test
    fun `garbage and empties are empty lists`() {
        assertTrue(LocateParser.parse("").isEmpty())
        assertTrue(LocateParser.parse("not json").isEmpty())
        assertTrue(LocateParser.parse("""{"file":"/w/a.ts"}""").isEmpty())
        assertTrue(LocateParser.parse("""{"placements":[]}""").isEmpty())
    }
}
