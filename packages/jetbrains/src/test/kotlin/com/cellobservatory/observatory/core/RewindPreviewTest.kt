package com.cellobservatory.observatory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rewind preflight's payload — `undo --from-prompt <id> --dry-run --json`.
 *
 * These three numbers go into a destructive confirmation, so every failure mode has to land somewhere the
 * dialog can state honestly: a real preview fills the sentence, an unreadable answer returns null and the
 * dialog falls back to naming the scope without numbers, and a payload that is NOT a preview but a
 * completed revert is flagged rather than mistaken for one — that case means files on disk were rewritten
 * with no confirmation, which must be reported, not silently degraded.
 */
class RewindPreviewTest {

    @Test
    fun `a preview carries the raw records, the review units and the file count`() {
        val p = ObservatoryCli.parseRewindPreview(
            """{"dryRun":true,"pending":6,"units":4,"files":["/w/a.ts","/w/b.ts","/w/c.ts"],"ids":[3,4,5,6,7,8]}"""
        )
        assertEquals(6, p?.pending)
        assertEquals(4, p?.units) // units < pending: a same-code group straddles the boundary
        assertEquals(3, p?.files)
        assertFalse("a dry run performed nothing", p!!.performed)
    }

    @Test
    fun `a valid prompt with nothing pending is a zero, not a failure`() {
        val p = ObservatoryCli.parseRewindPreview("""{"dryRun":true,"pending":0,"units":0,"files":[],"ids":[]}""")
        assertEquals(0, p?.pending)
        assertEquals(0, p?.files)
    }

    @Test
    fun `an absent file list reads as no count rather than as zero files`() {
        // 0 is what the dialog treats as "this build did not say", and it then omits the clause instead of
        // claiming a rewind touches no files while reverting six edits.
        val p = ObservatoryCli.parseRewindPreview("""{"dryRun":true,"pending":6,"units":6}""")
        assertEquals(6, p?.pending)
        assertEquals(0, p?.files)
    }

    @Test
    fun `a payload missing a count is refused outright`() {
        // Defaulting either number to 0 would put a fabricated figure in a destructive confirmation.
        assertNull(ObservatoryCli.parseRewindPreview("""{"dryRun":true,"units":4,"files":[]}"""))
        assertNull(ObservatoryCli.parseRewindPreview("""{"dryRun":true,"pending":6,"files":[]}"""))
    }

    @Test
    fun `a completed revert is never mistaken for a preview`() {
        // The shape `undo --from-prompt --json` emits when the flag was dropped: the work is already done.
        val p = ObservatoryCli.parseRewindPreview(
            """{"undone":6,"conflicts":0,"errors":0,"firstError":null,"total":6,"ids":[3,4,5],"units":4}"""
        )
        assertTrue("this build reverted instead of counting", p!!.performed)
        assertEquals(6, p.pending)
        assertEquals(4, p.units)
    }

    @Test
    fun `an unreadable or unrelated answer falls back to a count-free confirmation`() {
        // Each of these must be null, so the dialog names the scope in prose instead of guessing.
        for (s in listOf("", "not json", "[]", """{"ok":true}""", """{"dryRun":false}""")) {
            assertNull("\"$s\" must not parse as a preview", ObservatoryCli.parseRewindPreview(s))
        }
    }
}
