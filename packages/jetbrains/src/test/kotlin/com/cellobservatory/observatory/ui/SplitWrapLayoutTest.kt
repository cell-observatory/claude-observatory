package com.cellobservatory.observatory.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.Dimension
import javax.swing.JPanel

/**
 * Geometry tests for the Overview top-toolbar layout. The two clusters sit side by side — left pinned
 * left, right pinned right — while they fit, and the right cluster wraps onto a second line (growing the
 * row's preferred height) when the width can't hold both. Guards the fix for the clipped narrow navbar.
 */
class SplitWrapLayoutTest {
    private val vgap = 3
    private fun stub(w: Int, h: Int) = JPanel().apply { preferredSize = Dimension(w, h) }

    /** A row with a 200-wide left cluster and a 150-wide right cluster, laid out at [width] px. */
    private fun row(width: Int): JPanel =
        JPanel(SplitWrapLayout(vgap)).apply {
            add(stub(200, 24)) // child 0 = LEFT
            add(stub(150, 24)) // child 1 = RIGHT
            setSize(width, 100)
            doLayout()
        }

    @Test
    fun `wide row keeps the split - left pinned left, right pinned right, one line`() {
        val width = 500 // 200 + 150 = 350 <= 500 -> both fit
        val p = row(width)
        val left = p.getComponent(0)
        val right = p.getComponent(1)
        assertEquals("left pinned to x=0", 0, left.x)
        assertEquals("left on the top line", 0, left.y)
        assertEquals("right pinned to the right edge", width - 150, right.x)
        assertEquals("right on the same line", 0, right.y)
        assertEquals("one-row height", 24, p.layout.preferredLayoutSize(p).height)
    }

    @Test
    fun `narrow row wraps - right cluster drops to a second line and the row grows`() {
        val width = 300 // 200 + 150 = 350 > 300 -> wraps
        val p = row(width)
        val left = p.getComponent(0)
        val right = p.getComponent(1)
        assertEquals("left stays on the top line at x=0", 0, left.x)
        assertEquals("left on the top line", 0, left.y)
        assertEquals("right wraps to the left edge", 0, right.x)
        assertEquals("right drops below the left cluster", 24 + vgap, right.y)
        assertEquals("two-row height (left + gap + right)", 24 + vgap + 24, p.layout.preferredLayoutSize(p).height)
    }

    @Test
    fun `reports unbounded max width so a BoxLayout host stretches it to the full toolbar width`() {
        val max = SplitWrapLayout(vgap).maximumLayoutSize(JPanel())
        assertTrue("max width is unbounded", max.width >= Int.MAX_VALUE / 2)
    }
}
