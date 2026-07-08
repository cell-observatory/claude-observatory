package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.EditRecord
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
        // Regroup by class once background locate results land (placementsFor above is async).
        com.cellobservatory.observatory.services.PlacementsCache.getInstance(project).addUpdateListener { rebuild() }
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

    // --- tree building ---

    fun rebuild() {
        val log = service().log()
        root.removeAllChildren()
        if (log.isNotEmpty()) {
            val base = project.basePath
            val byRel = LinkedHashMap<String, MutableList<EditRecord>>()
            for (r in log) {
                val rel = relPath(base, r.file)
                byRel.getOrPut(rel) { mutableListOf() }.add(r)
            }
            addChildren("", byRel.keys.toList(), byRel, root)
        }
        model.reload()
        TreeUtil.expandAll(tree)
    }

    private fun relPath(base: String?, file: String): String {
        if (base != null && file.startsWith("$base/")) return file.removePrefix("$base/")
        return file.trimStart('/')
    }

    /** Folder grouping with single-child chain compaction — port of the VS Code tree logic. */
    private fun addChildren(
        prefix: String,
        rels: List<String>,
        byRel: Map<String, List<EditRecord>>,
        parent: DefaultMutableTreeNode,
    ) {
        val files = rels.filter { !it.removePrefix(prefix).contains('/') }
        val folderGroups = rels.filter { it.removePrefix(prefix).contains('/') }
            .groupBy { it.removePrefix(prefix).substringBefore('/') }
        for ((seg, children) in folderGroups.toSortedMap()) {
            var label = seg
            var pfx = "$prefix$seg/"
            while (true) { // compact folder chains with a single folder child and no terminating file
                val subs = children.map { it.removePrefix(pfx) }
                if (subs.isEmpty() || subs.any { !it.contains('/') }) break
                val nextSegs = subs.map { it.substringBefore('/') }.toSet()
                if (nextSegs.size != 1) break
                label += "/${nextSegs.first()}"
                pfx += "${nextSegs.first()}/"
            }
            val node = DefaultMutableTreeNode(NodeData.Folder(label))
            parent.add(node)
            addChildren(pfx, children, byRel, node)
        }
        for (rel in files.sorted()) {
            val recs = byRel[rel] ?: continue
            val fileNode = DefaultMutableTreeNode(NodeData.FileN(rel, recs.first().file, recs))
            parent.add(fileNode)
            addFileChildren(fileNode, recs)
        }
    }

    /** Group a file's edits under the class each currently falls in (folder → file → class → edit).
     *  Line geometry comes from the placements cache; a cache miss renders flat and regroups when
     *  the background locate lands (the cache update triggers a service refresh → rebuild). */
    private fun addFileChildren(fileNode: DefaultMutableTreeNode, recs: List<EditRecord>) {
        val file = recs.first().file
        val f = File(file)
        val text = if (f.isFile && f.length() < 512 * 1024) runCatching { f.readText() }.getOrNull() else null
        val placements = text?.let {
            com.cellobservatory.observatory.services.PlacementsCache.getInstance(project)
                .placementsFor(file, it, "${f.lastModified()}:${f.length()}")
        }
        val spans = text?.let { com.cellobservatory.observatory.core.Classes.detectClasses(it) } ?: emptyList()
        if (text == null || placements == null || spans.isEmpty()) {
            for (r in recs) fileNode.add(DefaultMutableTreeNode(editData(r)))
            return
        }
        val byClass = LinkedHashMap<String, Pair<com.cellobservatory.observatory.core.ClassSpan, MutableList<EditRecord>>>()
        val loose = mutableListOf<EditRecord>()
        for (r in recs) {
            val line = placements.find { it.id == r.id }?.lines?.firstOrNull()
            val span = line?.let { com.cellobservatory.observatory.core.Classes.classAt(spans, it) }
            if (span == null) loose.add(r)
            else byClass.getOrPut("${span.name}@${span.start}") { span to mutableListOf() }.second.add(r)
        }
        for ((span, edits) in byClass.values) {
            val clsNode = DefaultMutableTreeNode(NodeData.Cls(span.name, edits.size, edits.count { it.pending }))
            fileNode.add(clsNode)
            for (r in edits) clsNode.add(DefaultMutableTreeNode(editData(r)))
        }
        for (r in loose) fileNode.add(DefaultMutableTreeNode(editData(r)))
    }

    private fun editData(rec: EditRecord): NodeData.Edit {
        // Line delta comes from list --json in Phase 2's cache; a cheap blob-line diff keeps Phase 1 offline.
        val session = service().currentSession()
        var added = 0
        var removed = 0
        if (session != null) {
            val before = com.cellobservatory.observatory.core.StoreReader.readBlob(session, rec.beforeBlob)
            val after = com.cellobservatory.observatory.core.StoreReader.readBlob(session, rec.afterBlob)
            val b = if (before.isEmpty()) emptyList() else before.lines()
            val a = if (after.isEmpty()) emptyList() else after.lines()
            // upper-bound estimate (exact per-hunk deltas arrive with the placements cache)
            added = (a.size - b.size).coerceAtLeast(0)
            removed = (b.size - a.size).coerceAtLeast(0)
            if (added == 0 && removed == 0 && before != after) {
                added = 1; removed = 1
            }
        }
        return NodeData.Edit(rec, added, removed)
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
            action("Refresh", AllIcons.Actions.Refresh) { service().refresh() },
            action("Accept All Edits", AllIcons.Actions.Commit) {
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
        )
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryTree", group, true)
        tb.targetComponent = tree
        return tb.component
    }

    private fun buildPopupGroup(): DefaultActionGroup = DefaultActionGroup(
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
        action("Undo All in File", AllIcons.Actions.Rollback) {
            selectedFile()?.let { f -> withSession { s -> ReviewOps.undoAll(project, s, f.edits, File(f.file).name) } }
        },
    )

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
