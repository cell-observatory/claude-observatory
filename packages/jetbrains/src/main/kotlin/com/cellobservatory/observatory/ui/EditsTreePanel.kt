package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.TreeFileNode
import com.cellobservatory.observatory.model.TreeFolderNode
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.cellobservatory.observatory.ui.inline.InlineOverlay
import com.intellij.icons.AllIcons
import com.intellij.ide.CommonActionsManager
import com.intellij.ide.DefaultTreeExpander
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
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
        data class Folder(val label: String, val path: String, val edits: List<EditRecord>) : NodeData()
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

    private fun selectedFolder(): NodeData.Folder? =
        (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? NodeData.Folder

    // --- tree building (renders core's `tree --json` view-model; no local tree/class logic) ---

    fun rebuild() {
        val vm = service().editTree()
        val q = service().filterQuery
        tree.emptyText.clear()
        when {
            q.isNotBlank() -> tree.emptyText.appendLine("No edits match \"$q\"")
            !com.cellobservatory.observatory.core.ClaudePaths.hooksInstalled() -> {
                tree.emptyText.appendLine("No tracked Claude edits yet")
                tree.emptyText.appendLine("Run `claude-observatory init`, then let Claude Code edit.")
                tryTheDemoLine()
            }
            else -> {
                // Hooks are fine — never imply otherwise. A fresh session with prior work gets a
                // one-click switch (parity with the VS Code welcome-view split).
                val current = service().currentSession()
                // listSessions() is store-GLOBAL: intersect with THIS project's transcript ids or
                // the empty state would advertise an unrelated repo's session (parity: extension.ts).
                val here: Set<String> = project.basePath?.let { base ->
                    runCatching {
                        java.nio.file.Files.list(com.cellobservatory.observatory.core.ClaudePaths.projectDir(base)).use { s ->
                            s.map { it.fileName.toString() }
                                .filter { it.endsWith(".jsonl") }
                                .map { it.removeSuffix(".jsonl") }
                                .toList()
                                .toSet()
                        }
                    }.getOrNull()
                } ?: emptySet()
                val prior = com.cellobservatory.observatory.core.StoreReader.listSessions()
                    .firstOrNull { it.id != current && it.edits > 0 && it.id in here }
                if (prior != null) {
                    tree.emptyText.appendLine("No edits in this session yet — the hooks are working.")
                    tree.emptyText.appendLine(
                        "Switch to previous session (${prior.id.take(8)} · ${prior.edits} edits)",
                        com.intellij.ui.SimpleTextAttributes.LINK_ATTRIBUTES
                    ) {
                        ReviewOps.applySessionChoice(project, prior.id)
                    }
                    tree.emptyText.appendLine(
                        "Pick a session…",
                        com.intellij.ui.SimpleTextAttributes.LINK_ATTRIBUTES
                    ) { ReviewOps.chooseSession(project, tree) }
                } else {
                    tree.emptyText.appendLine("No edits in this session yet.")
                    tryTheDemoLine()
                    tree.emptyText.appendLine("Let Claude edit a file and it will appear here.")
                }
            }
        }
        root.removeAllChildren()
        if (vm != null) {
            for (f in vm.folders) addFolderNode(root, f)
            for (file in vm.files) addFileNode(root, file)
        }
        model.reload()
        expandAllBounded(tree)
    }

    private fun addFolderNode(parent: DefaultMutableTreeNode, f: TreeFolderNode) {
        val node = DefaultMutableTreeNode(NodeData.Folder(f.label, f.path, f.allEdits))
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
                        r.kept -> NavTint.KEEP
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
            action("Search Edits", NavTint.SEARCH) { searchEdits() },
            action("Review Previous Pending Edit", AllIcons.Actions.Back) { reviewPrev() },
            action("Review Next Pending Edit", AllIcons.Actions.Forward) { reviewNext() },
            action("Accept All Edits", NavTint.ACCEPT_ALL) {
                withSession { s -> ReviewOps.keepAll(project, s) }
            },
            action("Reject All Edits", NavTint.REVERT_ALL) {
                withSession { s -> ReviewOps.undoAll(project, s, service().log(), "this session") }
            },
            action("Redo All Edits", AllIcons.Actions.Redo) {
                withSession { s -> ReviewOps.redoAll(project, s, service().log(), "this session") }
            },
            fileScopedAction("Accept All Edits in Current File", NavTint.ACCEPT_FILE) { s, vf ->
                ReviewOps.keepAll(project, s, service().log().filter { it.file == vf.path }, vf.name)
            },
            fileScopedAction("Reject All Edits in Current File", NavTint.REJECT) { s, vf ->
                ReviewOps.undoAll(project, s, service().log().filter { it.file == vf.path }, vf.name, vf.path)
            },
            action("Clear Resolved Edits", NavTint.CLEAR) {
                withSession { s ->
                    val resolved = service().log().count { !it.pending }
                    if (resolved > 0) ReviewOps.clearResolved(project, s, resolved)
                    else ReviewOps.notify(project, "No resolved edits to clear")
                }
            },
            action("Switch Session", AllIcons.Vcs.Branch) { ReviewOps.chooseSession(project, tree) },
            action("Refresh", AllIcons.Actions.Refresh) { service().refresh() },
            toggle("Toggle Inline Review", AllIcons.Actions.Show,
                { ObservatorySettings.instance.state.inlineReview },
                { on ->
                    ObservatorySettings.instance.state.inlineReview = on
                    InlineOverlay.getInstance(project).refreshAll()
                    // Transient status text, not a persistent balloon (parity with VS Code's toggle).
                    ReviewOps.status(project, "Inline review " + (if (on) "on" else "off"))
                }),
            action("Export Review Summary", AllIcons.ToolbarDecorator.Export) { exportSummary() },
            action("Setup Check (doctor)", AllIcons.General.Information) { ReviewOps.openDoctor(project) },
        )
        // Demo mode LAST, from the SHARED verb list the Overview's nav bar also builds from — two copies
        // is how one toolbar ends up offering a verb the other does not. It goes at the end because it is
        // the one group here that is not about the session you are reviewing; mid-toolbar it pushed the
        // review actions rightward and read as though the demo were part of the review flow.
        DemoVerbs.ALL.forEach { v -> group.add(demoAction(v.text, v.icon, v.wantDemo) { v.run(project) }) }
        // Collapse-all / expand-all for the folder → file → class tree — IntelliJ's own tree actions,
        // the platform equivalent of VS Code's file-Explorer Collapse-All button.
        val expander = DefaultTreeExpander(tree)
        val cam = CommonActionsManager.getInstance()
        group.addSeparator()
        group.add(cam.createCollapseAllAction(expander, tree))
        group.add(cam.createExpandAllAction(expander, tree))
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
        // Opt-in `claude -p` deep analysis (spends tokens): open the result as a markdown tab.
        action("Analyze Edit with Claude", Icons.Star) {
            selectedEdit()?.let { rec -> withSession { s -> ReviewOps.analyzeEdit(project, s, rec.id) } }
        },
        action("Keep", NavTint.KEEP) {
            selectedEdit()?.takeIf { it.pending }?.let { rec -> withSession { s -> ReviewOps.keep(project, s, rec.id) } }
        },
        action("Undo", NavTint.UNDO) {
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
        action("Keep All in File", NavTint.ACCEPT_FILE) {
            selectedFile()?.let { f -> withSession { s -> ReviewOps.keepAll(project, s, f.edits, File(f.file).name) } }
        },
        action("Undo All in File", NavTint.REJECT) {
            selectedFile()?.let { f -> withSession { s -> ReviewOps.undoAll(project, s, f.edits, File(f.file).name, f.file) } }
        },
        action("Clear Resolved in File", NavTint.CLEAR) {
            selectedFile()?.let { f ->
                withSession { s -> ReviewOps.clearResolvedScoped(project, s, f.edits.count { !it.pending }, File(f.file).name, f.file) }
            }
        },
        // Folder-scoped: accept / revert / clear every edit at-or-beneath the selected folder (parity
        // with VS Code's folder-row inline actions; reuses the file-scoped keep/undo plumbing).
        action("Accept All in Folder", NavTint.ACCEPT_FILE) {
            selectedFolder()?.let { f -> withSession { s -> ReviewOps.keepAll(project, s, f.edits, f.label) } }
        },
        action("Reject All in Folder", NavTint.REJECT) {
            selectedFolder()?.let { f -> withSession { s -> ReviewOps.undoAll(project, s, f.edits, f.label, f.path) } }
        },
        action("Clear Resolved in Folder", NavTint.CLEAR) {
            selectedFolder()?.let { f ->
                withSession { s -> ReviewOps.clearResolvedScoped(project, s, f.edits.count { !it.pending }, f.label, f.path) }
            }
        },
    )

    /** Export a shareable markdown review summary (kept/reverted per file) and open it in an editor tab.
     *  Runs the CLI off the EDT (parity with VS Code's core-in-process export — same markdown). */
    private fun exportSummary() = withSession { s ->
        ReviewOps.openMarkdown(
            project,
            "claude-review-summary",
            "Could not generate a review summary (is the claude-observatory CLI installed?)",
        ) { com.cellobservatory.observatory.core.ObservatoryCli.summaryMarkdown(s, project.basePath) }
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

    /**
     * The empty state's way into demo mode — the entry point that decides whether a first-time reader
     * ever finds it. Offered even when the capture hooks are missing, because the replay drives the
     * pipeline through the CLI directly and does not need them. Says "sidebar" rather than "every
     * panel": the dock panels shell out to the CLI, so a machine without it on PATH fills the trees and
     * the inline review and reports the missing CLI in the dock, which is what actually happens.
     */
    private fun tryTheDemoLine() {
        if (ReviewOps.demoPresent(project)) return
        tree.emptyText.appendLine(
            "Try the demo — no Claude session needed",
            com.intellij.ui.SimpleTextAttributes.LINK_ATTRIBUTES
        ) { ReviewOps.startDemo(project) }
    }

    /** A demo-mode button, shown only in the state its verb belongs to: Start before a demo is running,
     *  Restart and Exit while one is. Mirrors the VS Code title-bar `when` clauses. */
    private fun demoAction(text: String, icon: javax.swing.Icon, wantDemo: Boolean, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.BGT
            override fun update(e: AnActionEvent) {
                e.presentation.isEnabledAndVisible = ReviewOps.demoPresent(project) == wantDemo
            }
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    private fun toggle(text: String, icon: javax.swing.Icon, isOn: () -> Boolean, set: (Boolean) -> Unit): ToggleAction =
        object : ToggleAction(text, null, icon), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT
            override fun isSelected(e: AnActionEvent) = isOn()
            override fun setSelected(e: AnActionEvent, state: Boolean) = set(state)
        }

    private fun activeFile(): VirtualFile? = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()

    /** A bulk action scoped to the ACTIVE editor's file, gated (enabled+visible) on that file having
     *  pending edits. The tree toolbar has no VIRTUAL_FILE in its data context, so we read the active
     *  file from FileEditorManager (parity with VS Code's keepOpenFile/undoOpenFile). */
    private fun fileScopedAction(text: String, icon: javax.swing.Icon, run: (String, VirtualFile) -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT
            override fun update(e: AnActionEvent) {
                val path = activeFile()?.path
                e.presentation.isEnabledAndVisible = path != null && service().log().any { it.pending && it.file == path }
            }

            override fun actionPerformed(e: AnActionEvent) {
                val vf = activeFile() ?: return
                withSession { s -> run(s, vf) }
            }
        }
}
