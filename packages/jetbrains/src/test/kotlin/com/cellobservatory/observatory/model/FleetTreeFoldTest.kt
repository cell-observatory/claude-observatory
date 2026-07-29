package com.cellobservatory.observatory.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.swing.JTree
import javax.swing.event.TreeExpansionEvent
import javax.swing.event.TreeExpansionListener
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath

/**
 * The folded "older sessions" group must end a repaint in the state the READER chose — and the repaint
 * must not talk itself into a different answer by listening to its own expansions.
 */
class FleetTreeFoldTest {

    private class Fold(val count: Int)

    /** A tree shaped like the fleet: two live agents with subagents, then the folded group. */
    private fun tree(): Triple<JTree, DefaultMutableTreeNode, DefaultMutableTreeNode> {
        val root = DefaultMutableTreeNode("root")
        for (a in 1..2) {
            val agent = DefaultMutableTreeNode("agent$a")
            agent.add(DefaultMutableTreeNode("subagent$a"))
            root.add(agent)
        }
        val fold = DefaultMutableTreeNode(Fold(24))
        for (i in 1..24) fold.add(DefaultMutableTreeNode("old$i"))
        root.add(fold)
        val t = JTree(DefaultTreeModel(root))
        t.isRootVisible = false
        return Triple(t, root, fold)
    }

    private fun expanded(t: JTree, n: DefaultMutableTreeNode) = t.isExpanded(TreePath(n.path))

    @Test
    fun `a closed fold stays closed while everything else expands`() {
        val (t, root, fold) = tree()
        FleetTreeFold.apply(t, root, foldOpen = false) { it is Fold }
        assertFalse("the folded group must not be left open", expanded(t, fold))
        // The positive control that makes the assertion above mean something: the repaint really did
        // expand — otherwise "not expanded" would be true of a tree nothing had touched.
        val agent = root.getChildAt(0) as DefaultMutableTreeNode
        assertTrue("every non-folded agent is expanded, subagents and all", expanded(t, agent))
    }

    @Test
    fun `a fold the reader opened stays open`() {
        val (t, root, fold) = tree()
        FleetTreeFold.apply(t, root, foldOpen = true) { it is Fold }
        assertTrue("an expanded fold survives the repaint — a tick must not slam it shut", expanded(t, fold))
    }

    /**
     * The regression itself. The panel keeps `foldOpen` from a TreeExpansionListener, and the previous
     * implementation expanded the fold as a side effect of expanding everything — which fired that
     * listener, set foldOpen = true, and made the very next line skip the collapse. Here the listener is
     * live, exactly as in the panel, and the fold must STILL end closed.
     */
    @Test
    fun `the repaint does not flip the reader's own fold state by listening to itself`() {
        val (t, root, fold) = tree()
        var foldOpen = false
        // DELIBERATELY UNGUARDED. The panel also gates this listener while it repaints, but if the only
        // thing standing between the reader and a fold that springs open is that gate, then the rule
        // itself is still wrong — and a test that sets the gate cannot tell the two apart. It could not:
        // with the gate on, reinstating the original expand-everything-then-re-collapse implementation
        // still passed. Unguarded, that implementation expands the fold on tick one, the listener records
        // it as a reader gesture, and tick two leaves it open — which is exactly what shipped.
        var foldExpansions = 0
        t.addTreeExpansionListener(object : TreeExpansionListener {
            private fun isFold(e: TreeExpansionEvent) =
                (e.path?.lastPathComponent as? DefaultMutableTreeNode)?.userObject is Fold
            override fun treeExpanded(e: TreeExpansionEvent) { if (isFold(e)) { foldOpen = true; foldExpansions++ } }
            override fun treeCollapsed(e: TreeExpansionEvent) { if (isFold(e)) foldOpen = false }
        })
        repeat(3) { FleetTreeFold.apply(t, root, foldOpen) { it is Fold } } // three transcript ticks
        // The EVENT count, not just the end state. Expanding everything and re-collapsing afterwards also
        // ends collapsed, so an end-state assertion cannot tell the two apart — and it did not: the old
        // implementation passed every end-state check here. But it fires a real expansion on the fold
        // first, which any listener watching the tree observes, and which in the panel is what set the
        // flag that then suppressed the collapse. Never touching it is the property worth pinning.
        assertEquals("a closed fold is never expanded, not even transiently", 0, foldExpansions)
        assertFalse("no repaint may report the reader opened the fold", foldOpen)
        assertFalse("and it must still be collapsed after repeated ticks", expanded(t, fold))
    }

    @Test
    fun `the reader's gesture is honoured on the next tick`() {
        val (t, root, fold) = tree()
        var foldOpen = false
        var repainting = false
        t.addTreeExpansionListener(object : TreeExpansionListener {
            private fun isFold(e: TreeExpansionEvent) =
                (e.path?.lastPathComponent as? DefaultMutableTreeNode)?.userObject is Fold
            override fun treeExpanded(e: TreeExpansionEvent) { if (!repainting && isFold(e)) foldOpen = true }
            override fun treeCollapsed(e: TreeExpansionEvent) { if (!repainting && isFold(e)) foldOpen = false }
        })
        t.expandPath(TreePath(fold.path)) // the reader clicks it open
        assertTrue("the listener saw a real gesture", foldOpen)
        repainting = true
        try { FleetTreeFold.apply(t, root, foldOpen) { it is Fold } } finally { repainting = false }
        assertTrue("and the repaint leaves it open", expanded(t, fold))
    }

    @Test
    fun `a tree with no folded group is handled`() {
        val root = DefaultMutableTreeNode("root")
        val agent = DefaultMutableTreeNode("only-agent")
        agent.add(DefaultMutableTreeNode("subagent")) // a LEAF is never "expanded" — give it a child
        root.add(agent)
        val t = JTree(DefaultTreeModel(root)); t.isRootVisible = false
        FleetTreeFold.apply(t, root, foldOpen = false) { it is Fold }
        assertTrue("a fleet with nothing old enough to fold still expands normally", expanded(t, agent))
    }
}
