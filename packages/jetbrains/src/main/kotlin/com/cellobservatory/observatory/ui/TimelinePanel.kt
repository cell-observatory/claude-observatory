package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.services.ObserveCache
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.tree.TreeUtil
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreeSelectionModel

/**
 * Timeline: a newest-first change feed. Adjacent edits to the SAME file coalesce into a
 * collapsible run ("HH:MM  name ×N"); lone edits render directly. Click an edit to jump to it.
 */
class TimelinePanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    private data class Run(val file: String, val edits: List<EditRecord>)

    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree = Tree(model).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No tracked Claude edits in this project yet"
        cellRenderer = Renderer(project)
    }

    init {
        setContent(JBScrollPane(tree))
        val group = DefaultActionGroup(object : AnAction("Refresh", null, AllIcons.Actions.Refresh), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = ObservatoryService.getInstance(project).refresh()
        })
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryTimeline", group, true)
        tb.targetComponent = tree
        toolbar = tb.component
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount != 2) return
                val rec = (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? EditRecord ?: return
                val session = ObservatoryService.getInstance(project).currentSession() ?: return
                Navigate.openFileAtEdit(project, session, rec)
            }
        })
        ObservatoryService.getInstance(project).addListener { rebuild() }
        ObserveCache.getInstance(project).addListener { rebuild() } // summaries enrich run rows
        rebuild()
    }

    fun rebuild() {
        val log = ObservatoryService.getInstance(project).log().sortedByDescending { it.id }
        root.removeAllChildren()
        var i = 0
        while (i < log.size) {
            var j = i
            while (j + 1 < log.size && log[j + 1].file == log[i].file) j++
            val slice = log.subList(i, j + 1)
            if (slice.size == 1) {
                root.add(DefaultMutableTreeNode(slice[0]))
            } else {
                val runNode = DefaultMutableTreeNode(Run(slice[0].file, slice))
                for (r in slice) runNode.add(DefaultMutableTreeNode(r))
                root.add(runNode)
            }
            i = j + 1
        }
        model.reload()
        TreeUtil.expandAll(tree)
    }

    private class Renderer(private val project: Project) : ColoredTreeCellRenderer() {
        private val hhmm = SimpleDateFormat("HH:mm")

        private fun summaryFor(id: Int): String? =
            ObserveCache.getInstance(project).payload()?.edits?.find { it.id == id }
                ?.let { it.reasoning?.lineSequence()?.firstOrNull() ?: it.summary }

        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is Run -> {
                    icon = if (node.edits.any { it.pending }) AllIcons.General.Modified else AllIcons.Actions.Checked
                    append("${hhmm.format(Date(node.edits.first().ts))}  ${File(node.file).name}")
                    append("  ×${node.edits.size}", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    summaryFor(node.edits.first().id)?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                    toolTipText = node.file
                }
                is EditRecord -> {
                    icon = when {
                        node.kept -> AllIcons.Actions.Checked
                        node.undone -> AllIcons.Actions.Cancel
                        else -> AllIcons.General.Modified
                    }
                    val style = when {
                        node.undone -> SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, null)
                        node.kept -> SimpleTextAttributes.GRAYED_ATTRIBUTES
                        else -> SimpleTextAttributes.REGULAR_ATTRIBUTES
                    }
                    val isChild = (value as DefaultMutableTreeNode).parent !== tree.model.root
                    append(if (isChild) "#${node.id}" else "${hhmm.format(Date(node.ts))}  ${File(node.file).name}", style)
                    summaryFor(node.id)?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                    toolTipText = node.file
                }
            }
        }
    }
}
