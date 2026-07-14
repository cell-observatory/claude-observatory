package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.ActionGroup
import com.cellobservatory.observatory.model.ActionRecord
import com.cellobservatory.observatory.model.ActionsParser
import com.cellobservatory.observatory.model.EgressChannel
import com.cellobservatory.observatory.model.FleetSummary
import com.cellobservatory.observatory.model.SiblingSession
import com.cellobservatory.observatory.model.SubagentInfo
import com.cellobservatory.observatory.model.SubagentsSummary
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
import javax.swing.tree.TreePath
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
                if (res != null && res.fleet.any { !it.self }) { // concurrent sibling agents in this project, on top
                    val fNode = DefaultMutableTreeNode(FleetRoot(res.fleet, res.fleetSummary))
                    res.fleet.forEach { fNode.add(DefaultMutableTreeNode(it)) }
                    root.add(fNode)
                }
                if (res != null && res.egress.isNotEmpty()) { // "where did this session reach off-machine"
                    val egNode = DefaultMutableTreeNode(EgressRoot(res.egress))
                    res.egress.forEach { egNode.add(DefaultMutableTreeNode(it)) }
                    root.add(egNode)
                }
                if (res != null && res.subagents.isNotEmpty()) { // each subagent's own timeline + metrics
                    val sNode = DefaultMutableTreeNode(SubagentsRoot(res.subagents, res.subagentsSummary))
                    res.subagents.forEach { sub ->
                        val subNode = DefaultMutableTreeNode(sub)
                        sub.actions.forEach { subNode.add(DefaultMutableTreeNode(it)) }
                        sNode.add(subNode)
                    }
                    root.add(sNode)
                }
                val hasSubs = res != null && res.subagents.isNotEmpty()
                res?.groups?.forEach { g ->
                    // With the rich "Subagents" root shown, drop the raw "Subagents" category group so
                    // there aren't two identically-named top-level sections.
                    if (hasSubs && g.category == "agent") return@forEach
                    val gNode = DefaultMutableTreeNode(g)
                    g.actions.forEach { gNode.add(DefaultMutableTreeNode(it)) }
                    root.add(gNode)
                }
                model.reload()
                TreeUtil.expandAll(tree)
                // A subagent can have dozens of actions — keep each subagent collapsed (its parent
                // "Subagents" node stays open) so the tree isn't flooded; the user expands on demand.
                for (i in 0 until root.childCount) {
                    val child = root.getChildAt(i) as DefaultMutableTreeNode
                    if (child.userObject is SubagentsRoot) {
                        for (j in 0 until child.childCount) {
                            tree.collapsePath(TreePath((child.getChildAt(j) as DefaultMutableTreeNode).path))
                        }
                    }
                }
            }
        }
    }

    private fun action(text: String, icon: Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** Marker userObject for the "Egress" root node — carries the channels rendered under it. */
    private class EgressRoot(val channels: List<EgressChannel>)

    /** Marker userObject for the "Fleet" root node — the sibling sessions in this project. */
    private class FleetRoot(val sessions: List<SiblingSession>, val summary: FleetSummary?)

    /** Marker userObject for the "Subagents" root node — carries the subagents rendered under it. */
    private class SubagentsRoot(val subs: List<SubagentInfo>, val summary: SubagentsSummary?)

    private class Renderer : ColoredTreeCellRenderer() {
        private val AMBER = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, com.intellij.ui.JBColor.ORANGE)

        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is EgressRoot -> {
                    icon = AllIcons.General.Web
                    append("Egress")
                    val remote = node.channels.count { it.scope == "remote" }
                    append("  ${node.channels.size} destination${if (node.channels.size == 1) "" else "s"}" + if (remote > 0) " · $remote remote" else "", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "What this session touched off-machine — web, MCP, and network-shell destinations"
                }
                is EgressChannel -> {
                    icon = if (node.scope == "remote") AllIcons.General.Web else AllIcons.General.Information
                    append("${node.kind}  ")
                    append(node.target, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                    append("  ${node.scope}" + if (node.count > 1) " ×${node.count}" else "", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is FleetRoot -> {
                    icon = AllIcons.Nodes.ModuleGroup
                    append("Fleet")
                    val s = node.summary
                    if (s != null) {
                        append("  ${s.siblings} sibling${if (s.siblings == 1) "" else "s"}" + if (s.active > 0) " · ${s.active} active" else "", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    }
                    toolTipText = "Other Claude Code sessions working in this project — active/idle, pending edits, files touched, risk"
                }
                is SiblingSession -> {
                    icon = AllIcons.Nodes.Module
                    append(if (node.self) "(you) ${node.id.take(8)}" else node.id.take(8),
                        if (node.active) SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, com.intellij.ui.JBColor.GREEN) else SimpleTextAttributes.REGULAR_ATTRIBUTES)
                    append("  ${if (node.active) "active" else "idle"} · ${node.pending} pending · ${node.edits} edit${if (node.edits == 1) "" else "s"}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    if (node.riskTotal > 0) append("  ⚠ ${if (node.riskHigh > 0) "${node.riskHigh} high" else "${node.riskTotal}"}", if (node.riskHigh > 0) SimpleTextAttributes.ERROR_ATTRIBUTES else AMBER)
                    toolTipText = buildString {
                        append(if (node.self) "This session" else "Sibling").append(": ${node.id}\n")
                        append(if (node.active) "active" else "idle").append(" · last ${relTime(node.lastMs)}\n")
                        append("${node.edits} edit(s) · ${node.pending} pending")
                        if (node.riskTotal > 0) append("\n⚠ ${node.riskTotal} risky command(s)" + if (node.riskHigh > 0) " (${node.riskHigh} high)" else "")
                        if (node.files.isNotEmpty()) append("\nFiles: " + node.files.take(10).joinToString(", ") + if (node.moreFiles > 0) " +${node.moreFiles} more" else "")
                    }
                }
                is SubagentsRoot -> {
                    icon = AllIcons.Actions.RunAll
                    append("Subagents")
                    val s = node.summary
                    if (s != null) {
                        append("  ${s.count} · ${s.totalActions} action${if (s.totalActions == 1) "" else "s"}" + if (s.totalDurationMs > 0) " · ${fmtDur(s.totalDurationMs)}" else "", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                        if (s.errors > 0) append("  · ${s.errors} error${if (s.errors == 1) "" else "s"}", SimpleTextAttributes.ERROR_ATTRIBUTES)
                    }
                    toolTipText = "Each subagent Claude spawned this session, with its own action timeline + metrics (duration / tokens)"
                }
                is SubagentInfo -> {
                    icon = if (node.errors > 0) AllIcons.General.Warning else AllIcons.Actions.RunAll
                    val title = node.agentType ?: node.description ?: node.agentId.take(12)
                    append(title, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    val parts = mutableListOf<String>()
                    node.durationMs?.let { parts.add(fmtDur(it)) }
                    node.tokens?.let { parts.add("${humanTok(it)} tok") }
                    parts.add("${node.totalActions} action${if (node.totalActions == 1) "" else "s"}")
                    if (node.edits > 0) parts.add("${node.edits} edit${if (node.edits == 1) "" else "s"}")
                    append("  " + parts.joinToString(" · "), SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    if (node.errors > 0) append("  · ${node.errors} err", SimpleTextAttributes.ERROR_ATTRIBUTES)
                    toolTipText = buildString {
                        append(title)
                        if (node.status != null && node.status != "completed") append(" · ${node.status}")
                        if (node.description != null && node.agentType != null) append("\n${node.description}")
                        append("\nagent ${node.agentId}")
                    }
                }
                is ActionGroup -> {
                    icon = catIcon(node.category)
                    append(node.label)
                    val shown = if (node.actions.size < node.count) "${node.actions.size} of ${node.count}" else "${node.count}"
                    append("  $shown", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    if (node.errors > 0) append("  · ${node.errors} error${if (node.errors == 1) "" else "s"}", SimpleTextAttributes.ERROR_ATTRIBUTES)
                }
                is ActionRecord -> {
                    val risk = node.risk
                    icon = when {
                        node.isError -> AllIcons.Actions.Cancel
                        risk != null -> AllIcons.General.Warning
                        else -> catIcon(node.category)
                    }
                    val style = if (node.isError) SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes.REGULAR_ATTRIBUTES
                    append("${node.tool}  ", if (node.isError) SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    append(node.target.replace(Regex("\\s+"), " "), style)
                    if (risk != null) append("  ⚠ ${risk.level}", if (risk.level == "high") SimpleTextAttributes.ERROR_ATTRIBUTES else AMBER)
                    val meta = listOfNotNull(node.ts.takeIf { it > 0 }?.let { relTime(it) }, node.detail).joinToString(" · ")
                    if (meta.isNotEmpty()) append("  $meta", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = listOfNotNull(node.target, risk?.let { "⚠ ${it.reasons.joinToString(" · ")}" }, node.reasoning?.lineSequence()?.firstOrNull()?.let { "💭 $it" }).joinToString("\n")
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

/** ms → compact human duration (450ms / 3.2s / 2m 5s) — mirrors the CLI's fmtDur. */
private fun fmtDur(ms: Long): String {
    if (ms <= 0) return "0ms"
    if (ms < 1000) return "${ms}ms"
    val s = ms / 1000.0
    if (s < 60) return if (s < 10) String.format("%.1fs", s) else "${s.toInt()}s"
    val m = (s / 60).toInt()
    val rem = (s % 60).toInt()
    return if (rem > 0) "${m}m ${rem}s" else "${m}m"
}

/** Compact token count (47361 → 47k). */
private fun humanTok(n: Long): String {
    if (n < 1000) return n.toString()
    if (n < 1_000_000) return if (n < 10_000) String.format("%.1fk", n / 1000.0) else "${n / 1000}k"
    return String.format("%.1fM", n / 1_000_000.0)
}
