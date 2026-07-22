package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ChatRef
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.ActionGroup
import com.cellobservatory.observatory.model.ActionRecord
import com.cellobservatory.observatory.model.Collision
import com.cellobservatory.observatory.model.EgressChannel
import com.cellobservatory.observatory.model.MtActions
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath
import javax.swing.tree.TreeSelectionModel

/**
 * Actions (0.8.0 r4 — moved out of the Observations window into the Edits sidebar): the active session's
 * curated tool-call timeline in the same timeline STYLE — collapsible category subsections (Edits · Commands ·
 * Reads · Searches · Egress · To-dos), each action stamped with its HH:mm time; a file-edit action links to
 * its review (double-click opens the diff, right-click hands off a zero-token chat). Backed by
 * `multitask --json`'s `actions` section (buildActionGroups + egress, curated in core).
 *
 * This panel only paints — parity with the VS Code Actions view. Zero-token.
 */
class ActionsPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    @Volatile private var actions: MtActions? = null
    /** Live cross-agent file conflicts — moved here from the Overview's fleet nav (0.8.3): this is the
     *  session's audit surface, and a contested file is exactly the kind of thing it should lead with. */
    @Volatile private var collisions: List<Collision> = emptyList()

    private val actionsRoot = DefaultMutableTreeNode()
    private val actionsModel = DefaultTreeModel(actionsRoot)
    private val actionsTree = Tree(actionsModel).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No tool calls yet — the active session's Edits / Commands / Reads / Searches / Egress / To-dos appear here"
        cellRenderer = ActionsRenderer()
    }

    init {
        setContent(JBScrollPane(actionsTree))

        // Double-click a file-edit action → open it for review; right-click → zero-token chat.
        actionsTree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount != 2) return
                // A conflict row opens the contested file itself.
                ((actionsTree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? Collision)?.let { c ->
                    val vf = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByPath(c.file)
                    if (vf == null) ReviewOps.notify(project, "File not found: ${c.file}", com.intellij.notification.NotificationType.WARNING)
                    else com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(vf, true)
                    return
                }
                val a = (actionsTree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? ActionRecord ?: return
                val id = a.editId ?: return // only file-edit actions link to a reviewable store record
                val session = session() ?: return
                val rec = StoreReader.findRecord(session, id) ?: return
                Navigate.openFileAtEdit(project, session, rec)
            }

            override fun mousePressed(e: MouseEvent) = maybePopup(e)
            override fun mouseReleased(e: MouseEvent) = maybePopup(e)
            private fun maybePopup(e: MouseEvent) {
                if (!e.isPopupTrigger) return
                val path = actionsTree.getPathForLocation(e.x, e.y) ?: return
                actionsTree.selectionPath = path
                val action = (path.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? ActionRecord ?: return
                val editId = action.editId ?: return // only file-edit actions carry a store link to chat about
                val session = session() ?: return
                javax.swing.JPopupMenu().apply {
                    add(javax.swing.JMenuItem("Chat About This Action").apply {
                        addActionListener { ReviewOps.chatContext(project, session, ChatRef.Edit(editId), "${action.tool} action") }
                    })
                }.show(actionsTree, e.x, e.y)
            }
        })

        ObservatoryService.getInstance(project).addListener { rebuild() }
        rebuild()
    }

    private fun session(): String? = ObservatoryService.getInstance(project).currentSession()

    // --- data / paint (multitask --json's curated actions section, off the EDT; repaint back on it) ---

    fun rebuild() {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
        if (session == null) {
            actions = null
            ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) repaintActions() }
            return
        }
        // The SHARED throttled multitask view (0.8.0 stabilization) — this panel used to spawn its own
        // `multitask --json` on every watcher tick, duplicating the Overview's spawn in the same window.
        val mt = service.multitask()
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            actions = mt?.actions
            collisions = mt?.collisions ?: emptyList()
            repaintActions()
        }
    }

    /** Paint the curated category groups (Edits / Commands / Reads / Searches / To-dos …) then an Egress
     *  destinations root. The fleet/subagent categories are already dropped in core — the panel only paints. */
    private fun repaintActions() {
        actionsRoot.removeAllChildren()
        // Conflicts lead — they need eyes NOW (unlike the calm categories below, they start expanded).
        val cols = collisions
        var conflictsNode: DefaultMutableTreeNode? = null
        if (cols.isNotEmpty()) {
            conflictsNode = DefaultMutableTreeNode(ConflictsRoot(cols))
            cols.forEach { conflictsNode.add(DefaultMutableTreeNode(it)) }
            actionsRoot.add(conflictsNode)
        }
        val a = actions
        a?.groups?.forEach { g ->
            val gNode = DefaultMutableTreeNode(g)
            g.actions.forEach { gNode.add(DefaultMutableTreeNode(it)) }
            actionsRoot.add(gNode)
        }
        if (a != null && a.egress.isNotEmpty()) { // "where did this session reach off-machine"
            val egNode = DefaultMutableTreeNode(EgressRoot(a.egress))
            a.egress.forEach { egNode.add(DefaultMutableTreeNode(it)) }
            actionsRoot.add(egNode)
        }
        actionsModel.reload()
        // Categories collapsed by default: expand only the (hidden) root so the category headers show,
        // but leave each category's rows collapsed — the user expands the ones they want. Live conflicts
        // are the exception: they start expanded.
        actionsTree.expandPath(TreePath(actionsRoot))
        conflictsNode?.let { actionsTree.expandPath(TreePath(it.path)) }
    }

    /** Marker userObject for the Egress root — carries the off-machine destinations under it. */
    private class EgressRoot(val channels: List<EgressChannel>)

    /** Marker userObject for the Live-conflicts root (files pending in 2+ both-active agents). */
    private class ConflictsRoot(val collisions: List<Collision>)

    /** Renders the Actions timeline: category groups (Edits / Commands / Reads / Searches / To-dos …), their
     *  tool calls (each stamped HH:mm), and the Egress destinations root — the same timeline style. */
    private inner class ActionsRenderer : ColoredTreeCellRenderer() {
        private val hhmm = SimpleDateFormat("HH:mm")
        private val amber = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, JBColor.ORANGE)

        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is ConflictsRoot -> {
                    icon = AllIcons.General.Warning
                    append("Live conflicts", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, JBColor.ORANGE))
                    val pend = node.collisions.count { it.anyPending }
                    append("  ${node.collisions.size}" + if (pend > 0) " · $pend pending" else "", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "Files being touched by more than one active agent right now — double-click one to open it"
                }
                is Collision -> {
                    icon = AllIcons.Actions.Copy
                    append(node.file.substringAfterLast('/'), amber)
                    append("  ${node.agents.size} agents" + if (node.anyPending) " · pending" else "", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = "${node.file} — ${node.agents.joinToString(", ") { it.take(8) }} · double-click to open"
                }
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
                    if (node.ts > 0) append("${hhmm.format(Date(node.ts))}  ", SimpleTextAttributes.GRAYED_ATTRIBUTES) // the timestamp
                    append("${node.tool}  ", if (node.isError) SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    append(node.target.replace(Regex("\\s+"), " "), style)
                    if (risk != null) append("  ⚠ ${risk.level}", if (risk.level == "high") SimpleTextAttributes.ERROR_ATTRIBUTES else amber)
                    node.detail?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                    toolTipText = listOfNotNull(node.target, risk?.let { "⚠ ${it.reasons.joinToString(" · ")}" }, node.reasoning?.lineSequence()?.firstOrNull()?.let { "💭 $it" }).joinToString("\n")
                }
            }
        }

        private fun catIcon(cat: String): javax.swing.Icon = when (cat) {
            "edit" -> AllIcons.Actions.EditSource
            "exec" -> AllIcons.Debugger.Console
            "read" -> AllIcons.Actions.Preview
            "search" -> AllIcons.Actions.Find
            "web" -> AllIcons.General.Web
            "agent" -> AllIcons.Actions.RunAll
            "todo" -> AllIcons.Actions.Checked
            "mcp" -> AllIcons.Nodes.Plugin
            "compact" -> AllIcons.Actions.Collapseall
            "meta" -> AllIcons.General.Settings
            else -> AllIcons.General.Information
        }
    }
}
