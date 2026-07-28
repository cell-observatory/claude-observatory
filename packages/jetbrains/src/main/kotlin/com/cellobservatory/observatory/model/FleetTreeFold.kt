package com.cellobservatory.observatory.model

import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.TreePath

/**
 * Expand a fleet tree after a repaint, leaving the "older sessions" group in whatever state the reader
 * last chose.
 *
 * This lives here, apart from the panel, so it can be driven by a test with a real [JTree] — the bug it
 * replaces was invisible to every test the plugin had, and provably wrong in two different ways:
 *
 *  1. `TreeUtil.expandAll(tree)` expands the folded group along with everything else. That fires
 *     `treeExpanded`, whose listener sets `foldOpen = true`, and the guarded re-collapse on the very
 *     next line is then skipped — so a week of finished sessions sprang open on every transcript tick.
 *  2. `expandAll` delegates to `promiseExpandAll` and drops the promise. On the path where that resolves
 *     asynchronously, the deferred expansion lands AFTER the collapse and re-opens it. Both timings end
 *     expanded, which is why "collapse afterwards" could never be made to work.
 *
 * Walking the nodes is synchronous, decides the fold exactly once, and never expands it as a side effect
 * of expanding something else.
 */
object FleetTreeFold {
    /**
     * @param isFold identifies the folded-group node; the panel passes `{ it is FoldedGroup }`.
     * @param foldOpen the reader's own last gesture — true only if THEY opened it.
     */
    fun apply(tree: JTree, root: DefaultMutableTreeNode, foldOpen: Boolean, isFold: (Any?) -> Boolean) {
        for (i in 0 until root.childCount) {
            val child = root.getChildAt(i) as? DefaultMutableTreeNode ?: continue
            if (isFold(child.userObject)) {
                if (foldOpen) expandSubtree(tree, child) else tree.collapsePath(TreePath(child.path))
            } else {
                expandSubtree(tree, child)
            }
        }
    }

    /** Expand a node and every descendant, synchronously. */
    private fun expandSubtree(tree: JTree, node: DefaultMutableTreeNode) {
        tree.expandPath(TreePath(node.path))
        for (i in 0 until node.childCount) (node.getChildAt(i) as? DefaultMutableTreeNode)?.let { expandSubtree(tree, it) }
    }
}
