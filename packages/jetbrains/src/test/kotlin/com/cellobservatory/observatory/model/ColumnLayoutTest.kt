package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The rules grouped columns follow, asserted where they are decided.
 *
 * Every one of these failures is silent in a running IDE: a group that folds to nothing, a divider that
 * forgets the width the reader dragged, a column arriving late and resetting its siblings. None throws,
 * none fails a build, and each reads as "the panel rearranged itself".
 */
class ColumnLayoutTest {

    private val runs = listOf("workflows", "tasks", "processes")

    @Test
    fun `folding the last column showing content is refused`() {
        var collapsed = ColumnLayout.collapse(runs, emptySet(), "workflows")
        assertEquals(setOf("workflows"), collapsed)
        collapsed = ColumnLayout.collapse(runs, collapsed, "tasks")
        assertEquals(setOf("workflows", "tasks"), collapsed)
        // …and the third would empty the group.
        val refused = ColumnLayout.collapse(runs, collapsed, "processes")
        assertEquals("the group's last readable column must refuse to fold", collapsed, refused)
        assertEquals(listOf("processes"), ColumnLayout.expanded(runs, refused))
    }

    @Test
    fun `folding an absent or already folded member changes nothing`() {
        assertEquals(emptySet<String>(), ColumnLayout.collapse(runs, emptySet(), "sessions"))
        val one = setOf("workflows")
        assertEquals(one, ColumnLayout.collapse(runs, one, "workflows"))
    }

    @Test
    fun `expanding brings a member back and leaves the others alone`() {
        val collapsed = setOf("workflows", "tasks")
        assertEquals(setOf("tasks"), ColumnLayout.expand(collapsed, "workflows"))
        assertEquals(collapsed, ColumnLayout.expand(collapsed, "processes"))
    }

    /**
     * The stored proportion is what makes a reopen restore the reader's width. Folding pins the divider to
     * the folded side — it must NOT be written back, or the width would be lost the moment a column folds.
     */
    @Test
    fun `a divider is pinned to the folded side and keeps its stored value otherwise`() {
        val left = listOf("workflows")
        val right = listOf("tasks", "processes")
        assertEquals(0.7f, ColumnLayout.dividerProportion(0.7f, left, right, emptySet()), 0.0001f)
        // right folded away entirely → all the width to the left
        assertEquals(1f, ColumnLayout.dividerProportion(0.7f, left, right, setOf("tasks", "processes")), 0.0001f)
        // left folded → it keeps only its rail
        assertEquals(0f, ColumnLayout.dividerProportion(0.7f, left, right, setOf("workflows")), 0.0001f)
        // one of the two on the right is enough for the divider to mean something again
        assertEquals(0.7f, ColumnLayout.dividerProportion(0.7f, left, right, setOf("tasks")), 0.0001f)
    }

    @Test
    fun `a stored proportion is clamped away from the edges`() {
        assertEquals(0.05f, ColumnLayout.dividerProportion(0f, listOf("a"), listOf("b"), emptySet()), 0.0001f)
        assertEquals(0.95f, ColumnLayout.dividerProportion(1f, listOf("a"), listOf("b"), emptySet()), 0.0001f)
    }

    /**
     * A member that arrives later (Processes, once the CLI answers for it) must APPEND a divider key, never
     * shift one — the keys for a group are a prefix of the keys for that group plus one more, which is what
     * lets the first divider keep the width the reader set before the third column existed.
     */
    @Test
    fun `a late column appends a divider key and renames none`() {
        val before = (0 until ColumnLayout.dividerCount(runs.take(2))).map { ColumnLayout.dividerKey("runs", it) }
        val after = (0 until ColumnLayout.dividerCount(runs)).map { ColumnLayout.dividerKey("runs", it) }
        assertEquals(listOf("runs:0"), before)
        assertEquals(listOf("runs:0", "runs:1"), after)
        assertEquals("the earlier keys must survive the new column", before, after.take(before.size))
    }

    @Test
    fun `columns stack rather than shrink below the content floor`() {
        val two = listOf("workflows", "tasks")
        assertFalse("two columns fit", ColumnLayout.mustStack(two, emptySet(), 2 * ColumnLayout.MIN_COLUMN_PX))
        assertTrue("one pixel short is short", ColumnLayout.mustStack(two, emptySet(), 2 * ColumnLayout.MIN_COLUMN_PX - 1))
        // A folded column releases its floor but still costs a RAIL, so the group needs both: two floors
        // plus one rail. These two widths straddle that exact line, which is the only place the rail's own
        // cost is visible at all.
        assertFalse(
            "a folded column releases its floor",
            ColumnLayout.mustStack(runs, setOf("processes"), 2 * ColumnLayout.MIN_COLUMN_PX + ColumnLayout.RAIL_PX),
        )
        assertTrue(
            "the rail a folded column leaves behind still takes width",
            ColumnLayout.mustStack(runs, setOf("processes"), 2 * ColumnLayout.MIN_COLUMN_PX + ColumnLayout.RAIL_PX - 1),
        )
        assertFalse("one column can always be as narrow as the pane", ColumnLayout.mustStack(two, setOf("tasks"), 10))
        assertFalse("an unmeasured pane is not a narrow one", ColumnLayout.mustStack(two, emptySet(), 0))
    }
}
