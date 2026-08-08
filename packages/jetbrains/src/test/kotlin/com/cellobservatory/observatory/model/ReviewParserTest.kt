package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the Kotlin mirror of `review --prompt --json --no-patch` — the payload the Review tab renders,
 * and the one place this plugin consumes core's same-code collapse. The fixture carries a `patch` key
 * on one unit deliberately: the parser must IGNORE unknown fields (a with-patch payload from an older
 * wrapper or a curious hand must not break parsing), and the tab renders no patch text either way.
 */
class ReviewParserTest {

    private val payload = """
      {"session":"s1",
       "prompt":{"id":"abc123","index":2,"ts":1000,"endTs":2000,"title":"tighten the parser","text":"tighten the parser please"},
       "units":[
         {"id":3,"members":[1,3],"file":"/w/parser.py","rel":"parser.py","tool":"Edit","status":"pending",
          "ts":1500,"added":1,"removed":1,"patch":"@@ -1,2 +1,2 @@\n def p():\n-    return 0\n+    return 2\n"},
         {"id":4,"members":[4],"file":"/w/test_parser.py","rel":"test_parser.py","tool":"Edit","status":"kept",
          "ts":1600,"added":2,"removed":0}
       ],
       "ids":[1,3,4],
       "summary":{"units":2,"pending":1,"added":3,"removed":1},
       "patchesOmittedFrom":null,
       "errors":[]}
    """.trimIndent()

    @Test
    fun `parses units with members and the group-expanded id set, tolerating a patch key`() {
        val r = ReviewParser.parse(payload)!!
        assertEquals("s1", r.session)
        assertEquals(2, r.prompt!!.index)
        assertEquals("tighten the parser", r.prompt!!.title)
        assertEquals(2, r.units.size)

        val u = r.units[0]
        assertEquals(3, u.id)
        assertEquals(listOf(1, 3), u.members)              // the unit's RAW members — what mutations act on
        assertEquals("parser.py", u.rel)
        assertTrue(u.pending)
        assertEquals(listOf(4), r.units[1].members)

        assertEquals(listOf(1, 3, 4), r.ids)
        assertEquals(2, r.unitCount)
        assertEquals(1, r.pending)
    }

    @Test
    fun `a session-wide payload (prompt null) parses — the tab's default view, not garbage`() {
        val r = ReviewParser.parse(payload.replace(Regex("\"prompt\":\\{[^}]*\\},"), "\"prompt\":null,"))!!
        assertNull(r.prompt)
        assertEquals(2, r.units.size)
        assertEquals(listOf(1, 3, 4), r.ids)
    }

    @Test
    fun `an empty members array falls back to the unit id, never to an empty mutation set`() {
        val r = ReviewParser.parse(payload.replace("\"members\":[4],", "\"members\":[],"))!!
        assertEquals(listOf(4), r.units[1].members)
    }

    @Test
    fun `hiddenIds is what the tree must not draw, and falls back to the dismissible set on an older CLI`() {
        // `cancelledIds` is what Dismiss ACTS on (pending chains); `hiddenIds` is what the tree must
        // not DRAW (any status), so it is a superset — a dismissed chain stays hidden rather than
        // coming back as thousands of greyed rows. An older CLI sends neither field, and the tree then
        // hides exactly what that build could name rather than hiding nothing.
        val withHidden = ReviewParser.parse(
            payload.replace("\"ids\":[1,3,4]", "\"cancelledIds\":[7,8],\"hiddenIds\":[7,8,9,10],\"ids\":[1,3,4]")
        )!!
        assertEquals(listOf(7, 8), withHidden.cancelledIds)
        assertEquals(listOf(7, 8, 9, 10), withHidden.hiddenIds)
        assertTrue("hiddenIds covers every dismissible id", withHidden.hiddenIds.containsAll(withHidden.cancelledIds))

        val olderCli = ReviewParser.parse(payload.replace("\"ids\":[1,3,4]", "\"cancelledIds\":[7,8],\"ids\":[1,3,4]"))!!
        assertEquals(listOf(7, 8), olderCli.hiddenIds)

        val neither = ReviewParser.parse(payload)!!
        assertEquals(emptyList<Int>(), neither.hiddenIds)
    }

    @Test
    fun `garbage answers null, not a throw`() {
        assertNull(ReviewParser.parse("not json"))
        assertNull(ReviewParser.parse("{}")) // no prompt — an answer that names no ask is no answer
    }
}
