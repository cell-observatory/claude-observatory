package com.cellobservatory.observatory.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.awt.Dimension
import java.awt.FlowLayout
import javax.swing.JPanel

/**
 * Geometry test for the Overview's review-axes row. WrapLayout keeps Diff/File/Folder/Prompt on one
 * centered line when they fit, and FLOWS them onto additional lines (growing the row's preferred height)
 * when the pane is too narrow — instead of the axis toolbars collapsing into an IntelliJ "…" overflow.
 */
class WrapLayoutTest {
    private val hgap = 2
    private val vgap = 3

    private fun stub(w: Int, h: Int) = JPanel().apply { preferredSize = Dimension(w, h) }

    /** Four 120x24 "axes" laid out at [width] px. */
    private fun row(width: Int): JPanel =
        JPanel(WrapLayout(FlowLayout.CENTER, hgap, vgap)).apply {
            repeat(4) { add(stub(120, 24)) }
            setSize(width, 100)
        }

    @Test
    fun `wide pane keeps the axes on one row`() {
        val p = row(600) // 4 * 120 + gaps = ~486 <= 596 -> one row
        assertEquals("one-row height (row + vertical gaps)", 24 + vgap * 2, p.layout.preferredLayoutSize(p).height)
    }

    @Test
    fun `narrow pane wraps the axes onto a second row and grows the height`() {
        val wideH = row(600).let { it.layout.preferredLayoutSize(it).height }
        val narrowH = row(250).let { it.layout.preferredLayoutSize(it).height } // 2 per row -> 2 rows
        assertTrue("wrapping increases height ($narrowH > $wideH)", narrowH > wideH)
        assertEquals("two-row height", 24 * 2 + vgap + vgap * 2, narrowH)
    }
}
