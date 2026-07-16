package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.ObservationEdit
import com.cellobservatory.observatory.model.ObservationRun
import com.cellobservatory.observatory.model.Observations
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.tree.TreeUtil
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import javax.swing.JComponent
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreeSelectionModel

/**
 * Observations (0.8.0 r4 — the single reasoning feed): the session recap on top, then the edit timeline in
 * chronological-run STYLE (files by most-recent activity; adjacent same-file edits coalesce into ×N runs with
 * a combined delta, expandable to their per-edit rows with Keep/Undo), Claude's own reasoning inline on each
 * edit, and the still-open Next steps at the end. Backed by one `observations --json` payload (assembled in
 * core). The Actions tool-call timeline now lives in the Edits sidebar (ActionsPanel).
 *
 * This panel only paints — parity with the VS Code Observations view. Keep/Undo route through the store-
 * mutation CLI (ReviewOps), zero-token.
 */
class ObservationsPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    private object RecapMarker
    private object StepsMarker

    @Volatile private var data: Observations? = null

    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree = Tree(model).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No tracked Claude edits in this project yet"
        cellRenderer = Renderer()
    }

    init {
        setContent(JBScrollPane(tree))
        toolbar = buildToolbar()
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) selectedEdit()?.let { openEdit(it.id) }
            }
        })
        PopupHandler.installPopupMenu(tree, buildPopupGroup(), "ClaudeObservatoryObsPopup")

        ObservatoryService.getInstance(project).addListener { rebuild() }
        rebuild()
    }

    // --- selection: an ObservationEdit row, or a single-edit run (which stands in for its lone edit) ---

    private fun selectedEdit(): ObservationEdit? =
        when (val o = (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject) {
            is ObservationEdit -> o
            is ObservationRun -> if (o.count == 1) o.edits.firstOrNull() else null
            else -> null
        }

    // --- data / paint (one observations --json payload; off the EDT, repaint back on it) ---

    fun rebuild() {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
        if (session == null) {
            data = null
            ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) repaintTree() }
            return
        }
        // The SHARED throttled observations view (0.8.0 stabilization) — one spawn per ~3s across the
        // window; get() serves the latest cached view now and re-fires the listener when fresh data lands.
        val res = service.observations()
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            data = res
            repaintTree()
        }
    }

    private fun repaintTree() {
        root.removeAllChildren()
        val d = data
        if (d != null && d.runs.isNotEmpty()) {
            root.add(DefaultMutableTreeNode(RecapMarker)) // the session recap heads the timeline
            for (r in d.runs) {
                val runNode = DefaultMutableTreeNode(r)
                // A lone edit is its own run (count 1) — render it as a leaf so its row IS the edit; only
                // multi-edit runs expand into per-edit rows (with Keep/Undo).
                if (r.count > 1) for (e in r.edits) runNode.add(DefaultMutableTreeNode(e))
                root.add(runNode)
            }
        }
        // Next-steps: Claude's own open to-dos + heuristic follow-ups (shown independently of the timeline).
        if (d != null && d.nextSteps.isNotEmpty()) {
            root.add(DefaultMutableTreeNode(StepsMarker))
            for (s in d.nextSteps) root.add(DefaultMutableTreeNode(s))
        }
        model.reload()
        TreeUtil.expandAll(tree)
    }

    // --- keep / undo (per-edit — expand a run to its rows), + open / diff / chat ---

    private fun session(): String? = ObservatoryService.getInstance(project).currentSession()

    private fun keepSelected() {
        val session = session() ?: return
        val edit = selectedEdit() ?: return ReviewOps.notify(project, "Select an edit to keep (expand a run to its rows)")
        if (edit.status != "pending") return ReviewOps.notify(project, "Edit #${edit.id} is already ${edit.status}")
        ReviewOps.keep(project, session, edit.id)
    }

    private fun undoSelected() {
        val session = session() ?: return
        val edit = selectedEdit() ?: return ReviewOps.notify(project, "Select an edit to undo (expand a run to its rows)")
        val rec = ObservatoryService.getInstance(project).log().find { it.id == edit.id }
            ?: return ReviewOps.notify(project, "Edit #${edit.id} is no longer in the store")
        ReviewOps.undoOrRedo(project, session, rec, redo = false)
    }

    private fun openEdit(id: Int) {
        val session = session() ?: return
        ObservatoryService.getInstance(project).log().find { it.id == id }?.let { Navigate.openFileAtEdit(project, session, it) }
    }

    private fun diffEdit(id: Int) {
        val session = session() ?: return
        ObservatoryService.getInstance(project).log().find { it.id == id }?.let { Diffs.show(project, session, it) }
    }

    private fun chatEdit(id: Int) {
        val session = session() ?: return
        ReviewOps.chatAbout(project, session, id)
    }

    // --- store maintenance (unique to this panel: install hooks, clean store) ---

    private fun installHooks() {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Installing capture hooks…", false) {
            override fun run(indicator: ProgressIndicator) {
                val r = ObservatoryCli.init(project.basePath)
                ApplicationManager.getApplication().invokeLater {
                    if (r.ok) {
                        ReviewOps.notify(project, "Capture hooks installed. Quit Claude Code and relaunch it — hooks are snapshotted at session start.")
                    } else {
                        ReviewOps.notify(project, "Install failed — is the claude-observatory CLI installed? ${r.stderr.take(200)}", NotificationType.ERROR)
                    }
                }
            }
        })
    }

    /** Store maintenance (parity with the CLI `clean`): GC orphaned blobs, or drop the whole session. */
    private fun cleanStore() {
        val session = ObservatoryService.getInstance(project).currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        val gcOpt = "Reclaim disk — garbage-collect orphaned blobs"
        val dropOpt = "Drop this session — delete its edits + blobs (files on disk are unchanged)"
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createPopupChooserBuilder(listOf(gcOpt, dropOpt))
            .setTitle("Clean the store")
            .setItemChosenCallback { chosen ->
                val drop = chosen == dropOpt
                if (drop) {
                    val ok = com.intellij.openapi.ui.Messages.showYesNoDialog(
                        project, "Drop session $session? This deletes its captured edits + blobs. Files on disk are NOT changed.",
                        "Claude Observatory", "Drop Session", "Cancel", com.intellij.openapi.ui.Messages.getWarningIcon(),
                    )
                    if (ok != com.intellij.openapi.ui.Messages.YES) return@setItemChosenCallback
                }
                ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Cleaning store…", false) {
                    override fun run(indicator: ProgressIndicator) {
                        val r = if (drop) ObservatoryCli.dropSession(session, project.basePath) else ObservatoryCli.gc(session, project.basePath)
                        ApplicationManager.getApplication().invokeLater {
                            if (r.ok) {
                                ObservatoryService.getInstance(project).refresh()
                                ReviewOps.notify(project, if (drop) "Dropped session $session." else "Reclaimed disk (GC complete).")
                            } else {
                                ReviewOps.notify(project, "Clean failed — ${r.stderr.take(160)}", NotificationType.ERROR)
                            }
                        }
                    }
                })
            }
            .createPopup()
            .showInCenterOf(tree)
    }

    // --- toolbar / menu / renderer ---

    private fun service() = ObservatoryService.getInstance(project)

    private fun withSession(block: (String) -> Unit) {
        val s = service().currentSession()
        if (s == null) {
            ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
            return
        }
        block(s)
    }

    private fun buildToolbar(): JComponent {
        val group = DefaultActionGroup(
            action("Accept All Edits", Icons.CheckAll) { withSession { s -> ReviewOps.keepAll(project, s) } },
            action("Revert All Edits", AllIcons.Actions.Rollback) {
                withSession { s -> ReviewOps.undoAll(project, s, service().log(), "this session") }
            },
            action("Clear Resolved Edits", AllIcons.Actions.GC) {
                withSession { s ->
                    val resolved = service().log().count { !it.pending }
                    if (resolved > 0) ReviewOps.clearResolved(project, s, resolved) else ReviewOps.notify(project, "No resolved edits to clear")
                }
            },
            action("Install Capture Hooks", AllIcons.Actions.Install) { installHooks() },
            action("Clean Store…", AllIcons.Vcs.Remove) { cleanStore() },
            action("Switch Session", AllIcons.Vcs.Branch) { ReviewOps.chooseSession(project, tree) },
            action("Refresh", AllIcons.Actions.Refresh) { service().observations(force = true); service().refresh() },
            action("Setup Check (doctor)", AllIcons.General.Information) { ReviewOps.openDoctor(project) },
        )
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryObs", group, true)
        tb.targetComponent = tree
        return tb.component
    }

    private fun buildPopupGroup() = DefaultActionGroup(
        action("Keep", AllIcons.Actions.Checked) { keepSelected() },
        action("Undo", AllIcons.Actions.Rollback) { undoSelected() },
        action("Open File at Edit", AllIcons.Actions.EditSource) { selectedEdit()?.let { openEdit(it.id) } },
        action("Show Diff", AllIcons.Actions.Diff) { selectedEdit()?.let { diffEdit(it.id) } },
        action("Chat About This Edit", AllIcons.General.Balloon) { selectedEdit()?.let { chatEdit(it.id) } },
    )

    private fun action(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    private inner class Renderer : ColoredTreeCellRenderer() {
        private val hhmm = SimpleDateFormat("HH:mm")

        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is RecapMarker -> {
                    icon = Icons.Microscope
                    val recap = data?.recap?.takeIf { it.isNotBlank() }
                    append(recap ?: "No recap yet — it fills in from Claude's session title / last summary.")
                    append("  session recap", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is StepsMarker -> {
                    icon = AllIcons.Actions.IntentionBulb
                    append("Next steps", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    append("  from Claude's to-dos + heuristics", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is String -> {
                    icon = AllIcons.General.ArrowRight
                    append(node, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                }
                is ObservationRun -> {
                    icon = when (node.status) {
                        "pending" -> AllIcons.General.Modified
                        "undone" -> AllIcons.Actions.Cancel
                        else -> AllIcons.Actions.Checked
                    }
                    val ts = node.edits.lastOrNull()?.ts ?: 0L
                    append((if (ts > 0) "${hhmm.format(Date(ts))}  " else "") + File(node.file).name)
                    if (node.count > 1) append("  ×${node.count}", SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                    if (node.added > 0 || node.removed > 0) append("  +${node.added} -${node.removed}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    val why = node.edits.firstNotNullOfOrNull { it.reasoning?.lineSequence()?.firstOrNull()?.takeIf { l -> l.isNotBlank() } }
                    if (why != null) append("  $why", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = buildString {
                        append(node.rel)
                        append("\n${node.count} edit(s) · +${node.added} -${node.removed} · ${node.status}")
                        if (node.count == 1) node.edits.firstOrNull()?.reasoning?.let { append("\n💭 $it") }
                    }
                }
                is ObservationEdit -> {
                    icon = when (node.status) {
                        "kept" -> AllIcons.Actions.Checked
                        "undone" -> AllIcons.Actions.Cancel
                        else -> AllIcons.General.Modified
                    }
                    val style = when (node.status) {
                        "undone" -> SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, null)
                        "kept" -> SimpleTextAttributes.GRAYED_ATTRIBUTES
                        else -> SimpleTextAttributes.REGULAR_ATTRIBUTES
                    }
                    append("#${node.id}", style)
                    if (node.added > 0 || node.removed > 0) append("  +${node.added} -${node.removed}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    node.reasoning?.lineSequence()?.firstOrNull()?.takeIf { it.isNotBlank() }
                        ?.let { append("  $it", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
                    toolTipText = buildString {
                        node.reasoning?.let { append("💭 $it\n") }
                        append("edit #${node.id} · +${node.added} -${node.removed} · ${node.status}")
                    }
                }
            }
        }
    }
}
