package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.TreeFileNode
import com.cellobservatory.observatory.model.TreeFolderNode
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.tree.TreeUtil
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreeSelectionModel

/**
 * The Edits / Diffs trees: folder (compacted chains) → file → edit, mirroring the VS Code views.
 * EDITS mode double-click opens the file at the edit; DIFFS mode opens the before⟷after diff.
 * Class-level grouping arrives with the Phase-2 placements cache (a locate() subprocess per file
 * per refresh would be too heavy here).
 */
class EditsTreePanel(private val project: Project, private val mode: Mode) :
    SimpleToolWindowPanel(true, true) {

    enum class Mode { EDITS, DIFFS }

    sealed class NodeData {
        data class Folder(val label: String) : NodeData()
        data class FileN(val rel: String, val file: String, val edits: List<EditRecord>) : NodeData()
        data class Cls(val name: String, val edits: Int, val pending: Int) : NodeData()
        data class Edit(val rec: EditRecord, val added: Int, val removed: Int) : NodeData()
    }

    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree = Tree(model).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No tracked Claude edits yet"
        emptyText.appendLine("Run `claude-observatory init`, then let Claude Code edit.")
        cellRenderer = Renderer()
    }
    private val refreshListener = Runnable { rebuild() }

    init {
        setContent(JBScrollPane(tree))
        toolbar = buildToolbar()
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) selectedEdit()?.let { activate(it) }
            }
        })
        PopupHandler.installPopupMenu(tree, buildPopupGroup(), "ClaudeObservatoryTreePopup")
        ObservatoryService.getInstance(project).addListener(refreshListener)
        rebuild()
    }

    private fun service() = ObservatoryService.getInstance(project)

    private fun activate(rec: EditRecord) {
        val session = service().currentSession() ?: return
        when (mode) {
            Mode.EDITS -> Navigate.openFileAtEdit(project, session, rec)
            Mode.DIFFS -> Diffs.show(project, session, rec)
        }
    }

    private fun selectedEdit(): EditRecord? =
        ((tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.Edit)?.rec

    private fun selectedFile(): NodeData.FileN? =
        (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.FileN

    // --- tree building (renders core's `tree --json` view-model; no local tree/class logic) ---

    fun rebuild() {
        val vm = service().editTree()
        val q = service().filterQuery
        tree.emptyText.clear()
        tree.emptyText.appendLine(if (q.isNotBlank()) "No edits match \"$q\"" else "No tracked Claude edits yet")
        if (q.isBlank()) tree.emptyText.appendLine("Run `claude-observatory init`, then let Claude Code edit.")
        root.removeAllChildren()
        if (vm != null) {
            for (f in vm.folders) addFolderNode(root, f)
            for (file in vm.files) addFileNode(root, file)
        }
        model.reload()
        TreeUtil.expandAll(tree)
    }

    private fun addFolderNode(parent: DefaultMutableTreeNode, f: TreeFolderNode) {
        val node = DefaultMutableTreeNode(NodeData.Folder(f.label))
        parent.add(node)
        for (sub in f.folders) addFolderNode(node, sub)
        for (file in f.files) addFileNode(node, file)
    }

    private fun addFileNode(parent: DefaultMutableTreeNode, file: TreeFileNode) {
        val fileNode = DefaultMutableTreeNode(NodeData.FileN(file.rel, file.file, file.allEdits))
        parent.add(fileNode)
        for (cls in file.classes) {
            val clsNode = DefaultMutableTreeNode(NodeData.Cls(cls.name, cls.edits.size, cls.edits.count { it.rec.pending }))
            fileNode.add(clsNode)
            for (e in cls.edits) clsNode.add(DefaultMutableTreeNode(NodeData.Edit(e.rec, e.added, e.removed)))
        }
        for (e in file.loose) fileNode.add(DefaultMutableTreeNode(NodeData.Edit(e.rec, e.added, e.removed)))
    }

    // --- rendering ---

    private class Renderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            val node = (value as? DefaultMutableTreeNode)?.userObject ?: return
            when (node) {
                is NodeData.Folder -> {
                    icon = AllIcons.Nodes.Folder
                    append(node.label)
                }
                is NodeData.FileN -> {
                    icon = AllIcons.FileTypes.Any_type
                    append(File(node.file).name)
                    val pending = node.edits.count { it.pending }
                    append("  ${node.edits.size} edit(s) · $pending pending", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = node.file
                }
                is NodeData.Cls -> {
                    icon = AllIcons.Nodes.Class
                    append(node.name)
                    append("  ${node.edits} edit(s) · ${node.pending} pending", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is NodeData.Edit -> {
                    val r = node.rec
                    icon = when {
                        r.kept -> AllIcons.Actions.Checked
                        r.undone -> AllIcons.Actions.Cancel
                        else -> AllIcons.General.Modified
                    }
                    val style = when {
                        r.undone -> SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, null)
                        r.kept -> SimpleTextAttributes.GRAYED_ATTRIBUTES
                        else -> SimpleTextAttributes.REGULAR_ATTRIBUTES
                    }
                    append("#${r.id}  +${node.added} −${node.removed}", style)
                    append("  ${r.status} · ${r.tool} · ${relTime(r.ts)}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = r.file
                }
            }
        }
    }

    // --- toolbar + context menu ---

    private fun buildToolbar(): javax.swing.JComponent {
        val group = DefaultActionGroup(
            action("Search Edits", AllIcons.Actions.Find) { searchEdits() },
            action("Review Previous Pending Edit", AllIcons.Actions.Back) { reviewPrev() },
            action("Review Next Pending Edit", AllIcons.Actions.Forward) { reviewNext() },
            action("Accept All Edits", Icons.CheckAll) {
                withSession { s -> ReviewOps.keepAll(project, s) }
            },
            action("Revert All Edits", AllIcons.Actions.Rollback) {
                withSession { s -> ReviewOps.undoAll(project, s, service().log(), "this session") }
            },
            action("Clear Resolved Edits", AllIcons.Actions.GC) {
                withSession { s ->
                    val resolved = service().log().count { !it.pending }
                    if (resolved > 0) ReviewOps.clearResolved(project, s, resolved)
                }
            },
            action("Switch Session", AllIcons.Vcs.Branch) { switchSession() },
            action("Refresh", AllIcons.Actions.Refresh) { service().refresh() },
            action("Export Review Summary", AllIcons.ToolbarDecorator.Export) { exportSummary() },
            action("Setup Check (doctor)", AllIcons.General.Information) { runDoctor() },
        )
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryTree", group, true)
        tb.targetComponent = tree
        return tb.component
    }

    private fun buildPopupGroup(): DefaultActionGroup = DefaultActionGroup(
        action("Review Previous Pending Edit", AllIcons.Actions.Back) { reviewPrev() },
        action("Review Next Pending Edit", AllIcons.Actions.Forward) { reviewNext() },
        action("Open File at Edit", AllIcons.Actions.EditSource) {
            selectedEdit()?.let { rec -> withSession { s -> Navigate.openFileAtEdit(project, s, rec) } }
        },
        action("Show Diff", AllIcons.Actions.Diff) {
            selectedEdit()?.let { rec -> withSession { s -> Diffs.show(project, s, rec) } }
        },
        action("Keep", AllIcons.Actions.Checked) {
            selectedEdit()?.takeIf { it.pending }?.let { rec -> withSession { s -> ReviewOps.keep(project, s, rec.id) } }
        },
        action("Undo", AllIcons.Actions.Rollback) {
            selectedEdit()?.takeIf { !it.undone }?.let { rec -> withSession { s -> ReviewOps.undoOrRedo(project, s, rec, redo = false) } }
        },
        action("Redo", AllIcons.Actions.Redo) {
            selectedEdit()?.takeIf { it.undone }?.let { rec -> withSession { s -> ReviewOps.undoOrRedo(project, s, rec, redo = true) } }
        },
        action("Open File", AllIcons.Actions.MenuOpen) {
            val file = selectedEdit()?.file ?: selectedFile()?.file
            file?.let {
                LocalFileSystem.getInstance().refreshAndFindFileByPath(it)?.let { vf ->
                    FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, vf), true)
                }
            }
        },
        action("Keep All in File", Icons.CheckAll) {
            selectedFile()?.let { f -> withSession { s -> ReviewOps.keepAll(project, s, f.edits, File(f.file).name) } }
        },
        action("Undo All in File", AllIcons.Actions.Rollback) {
            selectedFile()?.let { f -> withSession { s -> ReviewOps.undoAll(project, s, f.edits, File(f.file).name) } }
        },
    )

    /** Export a shareable markdown review summary (kept/reverted per file) and open it in an editor tab.
     *  Runs the CLI off the EDT (parity with VS Code's core-in-process export — same markdown). */
    private fun exportSummary() = withSession { s ->
        runAndOpenMarkdown("claude-review-summary", "Could not generate a review summary (is the claude-observatory CLI installed?)") {
            com.cellobservatory.observatory.core.ObservatoryCli.summaryMarkdown(s, project.basePath)
        }
    }

    /** Run `doctor` and open the setup diagnostics (hooks, PATH, config, session, status line) in a tab. */
    private fun runDoctor() {
        runAndOpenMarkdown("claude-observatory-doctor", "Could not run doctor (is the claude-observatory CLI installed?)") {
            com.cellobservatory.observatory.core.ObservatoryCli.doctorMarkdown(project.basePath)
        }
    }

    /** Fetch markdown off the EDT and open it in an editor tab (or notify on failure). */
    private fun runAndOpenMarkdown(name: String, errorMsg: String, produce: () -> String?) {
        val app = com.intellij.openapi.application.ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val md = produce()
            app.invokeLater {
                if (md.isNullOrBlank()) {
                    ReviewOps.notify(project, errorMsg)
                } else {
                    val tmp = File.createTempFile(name, ".md")
                    tmp.writeText(md)
                    LocalFileSystem.getInstance().refreshAndFindFileByPath(tmp.path)?.let { vf ->
                        FileEditorManager.getInstance(project).openFile(vf, true)
                    }
                }
            }
        }
    }

    /** Filter the Edits/Diffs trees by file path (empty clears). Shared via the service so both trees filter together. */
    private fun searchEdits() {
        val q = com.intellij.openapi.ui.Messages.showInputDialog(
            project,
            "Filter edits by file path (empty to clear):",
            "Search Edits",
            null,
            service().filterQuery,
            null,
        )
        if (q != null) service().setFilter(q)
    }

    /** Step to the next (⏭) / previous (⏮) pending edit, cycling through all of them (parity with VS Code). */
    private fun reviewNext() = withSession { s ->
        val next = service().nextPendingEdit()
        if (next == null) ReviewOps.notify(project, "No pending Claude edits — all caught up")
        else Navigate.openFileAtEdit(project, s, next)
    }

    private fun reviewPrev() = withSession { s ->
        val prev = service().prevPendingEdit()
        if (prev == null) ReviewOps.notify(project, "No pending Claude edits — all caught up")
        else Navigate.openFileAtEdit(project, s, prev)
    }

    /** Pin which capture session the observatory shows (e.g. the demo-showcase fixture) instead of the
     *  auto-resolved newest one — a chooser over every session in the store. */
    private fun switchSession() {
        val settings = com.cellobservatory.observatory.settings.ObservatorySettings.instance
        val pinned = settings.state.session?.takeIf { it.isNotBlank() }
        val auto = project.basePath?.let { com.cellobservatory.observatory.core.SessionResolver.resolveSessionId(it) }
        val labelToId = LinkedHashMap<String, String?>()
        labelToId["Auto — newest for this workspace" + (auto?.let { " ($it)" } ?: "")] = null
        for (s in com.cellobservatory.observatory.core.StoreReader.listSessions()) {
            val mark = if (s.id == pinned) "● " else ""
            val autoTag = if (s.id == auto) " · auto" else ""
            labelToId["$mark${s.id}  —  ${s.pending} pending · ${relTime(s.lastMs)}$autoTag"] = s.id
        }
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labelToId.keys.toList())
            .setTitle("Review which session?")
            .setItemChosenCallback { chosen ->
                settings.state.session = labelToId[chosen]
                for (p in com.intellij.openapi.project.ProjectManager.getInstance().openProjects) {
                    ObservatoryService.getInstance(p).refresh()
                }
            }
            .createPopup()
            .showInCenterOf(tree)
    }

    private fun withSession(block: (String) -> Unit) {
        val s = service().currentSession()
        if (s == null) {
            ReviewOps.notify(project, "No active Claude Code session for this project", com.intellij.notification.NotificationType.WARNING)
            return
        }
        block(s)
    }

    private fun action(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }
}
