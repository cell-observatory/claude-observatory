package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Parity pin for [TourVerdict] against core's `demoActionState`. Every case below is one core's own
 * test asserts; if this file and that file ever disagree, one editor reports a guided-tour step done
 * while the other keeps waiting on it — and nothing in either build would say so.
 */
class TourVerdictTest {

    private fun v(kind: String, bk: Int, bu: Int, kept: Int, undone: Int, pending: Int, total: Int) =
        TourVerdict.of(kind, bk, bu, kept, undone, pending, total)

    @Test
    fun `a keep step is satisfied only when the kept count goes up`() {
        assertEquals("waiting", v("keep-edit", 2, 0, 2, 0, 3, 5))
        assertEquals("satisfied", v("keep-edit", 2, 0, 3, 0, 2, 5))
        // Someone REVERTING an edit is not the accept the step asked for.
        assertEquals("waiting", v("keep-edit", 2, 0, 2, 1, 2, 5))
    }

    @Test
    fun `an undo step reads the undone count, never the kept one`() {
        assertEquals("waiting", v("undo-edit", 0, 1, 4, 1, 2, 5))
        assertEquals("satisfied", v("undo-edit", 0, 1, 4, 2, 1, 5))
        // An accept does not answer a step that asked for a revert.
        assertEquals("waiting", v("undo-edit", 3, 1, 4, 1, 1, 5))
    }

    @Test
    fun `both shapes of nothing-left-to-do resolve rather than hanging`() {
        // The whole log was cleared — a fully reviewed demo drops its own records.
        assertEquals("vacated", v("keep-edit", 2, 0, 0, 0, 0, 0))
        assertEquals("vacated", v("undo-edit", 0, 1, 0, 0, 0, 0))
        // Records remain, but none are pending: there is nothing left to accept.
        assertEquals("vacated", v("keep-edit", 2, 0, 2, 3, 0, 5))
        assertEquals("vacated", v("keep-prompt", 2, 0, 2, 3, 0, 5))
        assertEquals("vacated", v("keep-task", 2, 0, 2, 3, 0, 5))
        // …but an undo step with nothing pending is NOT vacated by that alone: the edits it would
        // revert are the resolved ones, and core says waiting here.
        assertEquals("waiting", v("undo-edit", 0, 3, 2, 3, 0, 5))
    }

    @Test
    fun `a kind this build has never heard of waits instead of guessing`() {
        // A newer CLI can ship a wait kind this plugin does not know. Reporting it satisfied on some
        // unrelated accept would be worse than leaving the reader to press Skip.
        assertEquals("waiting", v("keep-folder", 2, 0, 9, 9, 1, 12))
        assertEquals("waiting", v("", 0, 0, 5, 5, 1, 12))
    }
}
