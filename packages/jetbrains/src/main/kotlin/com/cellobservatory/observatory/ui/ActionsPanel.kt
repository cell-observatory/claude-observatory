package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.ActionGroup
import com.cellobservatory.observatory.model.ActionRecord
import com.cellobservatory.observatory.model.ActionsParser
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.tree.TreeUtil
import javax.swing.Icon
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreeSelectionModel
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent

/**
 * Actions timeline: EVERY tool call Claude made this session (reads, greps, bash, web, subagents,
 * to-dos), grouped by category and curated by default — parity with the VS Code Actions view. Fed by
 * the CLI `actions --json` (the single backend); the toggle flips curated ⇄ all.
 */
class ActionsPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    @Volatile private var showAll = false

    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree = Tree(model).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No actions yet — this fills in once Claude runs tools in this session"
        cellRenderer = Renderer()
    }

    init {
        setContent(JBScrollPane(tree))
        val toggle = object : ToggleAction("Show All Actions", "Include reads / searches / meta too", AllIcons.Actions.Show), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT
            override fun isSelected(e: AnActionEvent) = showAll
            override fun setSelected(e: AnActionEvent, state: Boolean) {
                showAll = state
                rebuild()
            }
        }
        val group = DefaultActionGroup(toggle, action("Refresh", AllIcons.Actions.Refresh) { rebuild() })
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryActions", group, true)
        tb.targetComponent = tree
        toolbar = tb.component

        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount != 2) return
                val a = (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? ActionRecord ?: return
                val id = a.editId ?: return // only file-edit actions link to a reviewable store record
                val session = ObservatoryService.getInstance(project).currentSession() ?: return
                val rec = StoreReader.findRecord(session, id) ?: return
                Navigate.openFileAtEdit(project, session, rec)
            }
        })

        ObservatoryService.getInstance(project).addListener { rebuild() }
        rebuild()
    }

    private fun rebuild() {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
        if (session == null) {
            root.removeAllChildren()
            model.reload()
            return
        }
        val workDir = service.workspaceRoot
        val all = showAll
        // The CLI call spawns a process — off the EDT; repaint back on it.
        ApplicationManager.getApplication().executeOnPooledThread {
            val res = ObservatoryCli.actionsJson(session, workDir, all)?.let { ActionsParser.parse(it) }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                root.removeAllChildren()
                res?.groups?.forEach { g ->
                    val gNode = DefaultMutableTreeNode(g)
                    g.actions.forEach { gNode.add(DefaultMutableTreeNode(it)) }
                    root.add(gNode)
                }
                model.reload()
                TreeUtil.expandAll(tree)
            }
        }
    }

    private fun action(text: String, icon: Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    private class Renderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is ActionGroup -> {
                    icon = catIcon(node.category)
                    append(node.label)
                    val shown = if (node.actions.size < node.count) "${node.actions.size} of ${node.count}" else "${node.count}"
                    append("  $shown", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    if (node.errors > 0) append("  · ${node.errors} error${if (node.errors == 1) "" else "s"}", SimpleTextAttributes.ERROR_ATTRIBUTES)
                }
                is ActionRecord -> {
                    icon = if (node.isError) AllIcons.Actions.Cancel else catIcon(node.category)
                    val style = if (node.isError) SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes.REGULAR_ATTRIBUTES
                    append("${node.tool}  ", if (node.isError) SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    append(node.target.replace(Regex("\\s+"), " "), style)
                    val meta = listOfNotNull(node.ts.takeIf { it > 0 }?.let { relTime(it) }, node.detail).joinToString(" · ")
                    if (meta.isNotEmpty()) append("  $meta", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = listOfNotNull(node.target, node.reasoning?.lineSequence()?.firstOrNull()?.let { "💭 $it" }).joinToString("\n")
                }
            }
        }

        private fun catIcon(cat: String): Icon = when (cat) {
            "edit" -> AllIcons.Actions.EditSource
            "exec" -> AllIcons.Debugger.Console
            "read" -> AllIcons.Actions.Preview
            "search" -> AllIcons.Actions.Find
            "web" -> AllIcons.General.Web
            "agent" -> AllIcons.Actions.RunAll
            "todo" -> AllIcons.Actions.Checked
            "mcp" -> AllIcons.Nodes.Plugin
            "meta" -> AllIcons.General.Settings
            else -> AllIcons.General.Information
        }
    }
}
