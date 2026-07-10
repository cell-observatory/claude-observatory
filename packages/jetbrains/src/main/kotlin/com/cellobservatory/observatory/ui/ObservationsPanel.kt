package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.ObsEdit
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.services.ObserveCache
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
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.PopupHandler
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.JBUI
import java.awt.Dimension
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.io.File
import javax.swing.JComponent
import javax.swing.JEditorPane
import javax.swing.JTree
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreeSelectionModel

/**
 * Observations: a session recap row on top (✨ regenerates it via `claude -p`), then one row per
 * edit — Claude's actual transcript reasoning, heuristic flags, and the cross-session memory of
 * the file (risky files get a warning icon). Click a row for the combined report; ✨ Analyze runs
 * the opt-in deep analysis. Data comes from one `observe --json` payload (ObserveCache).
 */
class ObservationsPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    private object RecapMarker

    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val tree = Tree(model).apply {
        isRootVisible = false
        showsRootHandles = false
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No tracked Claude edits in this project yet"
        cellRenderer = Renderer(project)
    }

    init {
        setContent(JBScrollPane(tree))
        toolbar = buildToolbar()
        tree.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount == 2) selectedObs()?.let { showReport(it) }
            }
        })
        PopupHandler.installPopupMenu(tree, buildPopupGroup(), "ClaudeObservatoryObsPopup")
        ObservatoryService.getInstance(project).addListener { rebuild() }
        ObserveCache.getInstance(project).addListener { rebuild() }
        rebuild()
    }

    private fun selectedObs(): ObsEdit? =
        (tree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject as? ObsEdit

    fun rebuild() {
        val payload = ObserveCache.getInstance(project).payload()
        root.removeAllChildren()
        if (payload != null && payload.edits.isNotEmpty()) {
            root.add(DefaultMutableTreeNode(RecapMarker))
            for (e in payload.edits) root.add(DefaultMutableTreeNode(e))
        }
        model.reload()
    }

    // --- report ---

    private fun showReport(obs: ObsEdit) {
        val html = buildString {
            append("<html><body style='font-family:sans-serif;margin:8px'>")
            append("<h2>Edit #${obs.id} — ${escape(File(obs.file).name)}</h2>")
            append("<p><b>${escape(obs.summary)}</b> · ${obs.tool} · ${obs.status} · ${relTime(obs.ts)}</p>")
            obs.reasoning?.let { append("<h3>💭 Claude's reasoning</h3><p>${escape(it)}</p>") }
            if (obs.flags.isNotEmpty()) {
                append("<h3>Flags</h3><ul>")
                for (f in obs.flags) append("<li>${if (f.level == "warn") "⚠" else "ℹ"} ${escape(f.message)}</li>")
                append("</ul>")
            }
            if (obs.memorySummary.isNotBlank()) {
                append("<h3>🧠 File memory</h3><p>${if (obs.risky) "⚠ " else ""}${escape(obs.memorySummary)}</p>")
            }
            obs.analysis?.let {
                append("<h3>✨ Deep analysis (Claude)</h3><p>${escape(it).replace("\n", "<br>")}</p>")
            }
            append("</body></html>")
        }
        object : DialogWrapper(project) {
            init {
                title = "Claude Observatory — Edit #${obs.id}"
                init()
            }

            override fun createCenterPanel(): JComponent {
                val pane = JEditorPane("text/html", html).apply { isEditable = false; caretPosition = 0 }
                return JBScrollPane(pane).apply { preferredSize = Dimension(JBUI.scale(560), JBUI.scale(420)) }
            }

            override fun createActions() = arrayOf(okAction)
        }.show()
    }

    private fun escape(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    // --- opt-in claude -p actions ---

    private fun analyze(obs: ObsEdit) {
        val session = ObservatoryService.getInstance(project).currentSession() ?: return
        if (obs.analysis != null) return showReport(obs) // cached — just open, like the VS Code flow
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Analyzing edit #${obs.id} with Claude…", false) {
            override fun run(indicator: ProgressIndicator) {
                val text = ObservatoryCli.analyze(session, obs.id, project.basePath)
                ApplicationManager.getApplication().invokeLater {
                    if (text == null) {
                        ReviewOps.notify(project, "Analyze failed — is the `claude` CLI on PATH?", NotificationType.ERROR)
                    } else {
                        ObserveCache.getInstance(project).invalidate()
                        rebuild()
                        showReport(obs.copy(analysis = text))
                    }
                }
            }
        })
    }

    private fun refreshRecap() {
        val session = ObservatoryService.getInstance(project).currentSession() ?: return
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Refreshing the session recap with Claude…", false) {
            override fun run(indicator: ProgressIndicator) {
                val text = ObservatoryCli.recap(session, fresh = true, workDir = project.basePath)
                ApplicationManager.getApplication().invokeLater {
                    if (text == null) {
                        ReviewOps.notify(project, "Recap failed — is the `claude` CLI on PATH?", NotificationType.ERROR)
                    } else {
                        ObserveCache.getInstance(project).invalidate()
                        rebuild()
                    }
                }
            }
        })
    }

    private fun chatAbout(obs: ObsEdit) {
        val session = ObservatoryService.getInstance(project).currentSession() ?: return
        ReviewOps.chatAbout(project, session, obs.id)
    }

    // --- toolbar / menu / renderer ---

    private fun buildToolbar(): JComponent {
        val group = DefaultActionGroup(
            action("Refresh Recap with Claude (spends tokens)", AllIcons.Actions.ForceRefresh) { refreshRecap() },
            action("Clear Resolved Edits", AllIcons.Actions.GC) {
                val service = ObservatoryService.getInstance(project)
                val session = service.currentSession()
                    ?: return@action ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
                val resolved = service.log().count { !it.pending }
                if (resolved > 0) ReviewOps.clearResolved(project, session, resolved) else ReviewOps.notify(project, "No resolved edits to clear")
            },
            action("Switch Session", AllIcons.Vcs.Branch) { ReviewOps.chooseSession(project, tree) },
            action("Refresh", AllIcons.Actions.Refresh) { ObservatoryService.getInstance(project).refresh() },
            action("Setup Check (doctor)", AllIcons.General.Information) { ReviewOps.openDoctor(project) },
        )
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryObs", group, true)
        tb.targetComponent = tree
        return tb.component
    }

    private fun buildPopupGroup() = DefaultActionGroup(
        action("Show Report", AllIcons.Actions.Preview) { selectedObs()?.let { showReport(it) } },
        action("Analyze with Claude (spends tokens)", AllIcons.Actions.IntentionBulb) { selectedObs()?.let { analyze(it) } },
        action("Chat About This Edit", AllIcons.General.Balloon) { selectedObs()?.let { chatAbout(it) } },
        action("Open File at Edit", AllIcons.Actions.EditSource) {
            val obs = selectedObs() ?: return@action
            val service = ObservatoryService.getInstance(project)
            val session = service.currentSession() ?: return@action
            service.log().find { it.id == obs.id }?.let { Navigate.openFileAtEdit(project, session, it) }
        },
        action("Show Diff", AllIcons.Actions.Diff) {
            val obs = selectedObs() ?: return@action
            val service = ObservatoryService.getInstance(project)
            val session = service.currentSession() ?: return@action
            service.log().find { it.id == obs.id }?.let { Diffs.show(project, session, it) }
        },
    )

    private fun action(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    private class Renderer(private val project: Project) : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is RecapMarker -> {
                    icon = Icons.Microscope
                    val recap = ObserveCache.getInstance(project).payload()?.recap
                    append(recap ?: "No recap yet — hit ✨ to generate one.")
                    append("  session recap", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is ObsEdit -> {
                    val warn = node.risky || node.flags.any { it.level == "warn" }
                    icon = if (warn) AllIcons.General.Warning else AllIcons.Actions.Show
                    val style = when (node.status) {
                        "undone" -> SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, null)
                        "kept" -> SimpleTextAttributes.GRAYED_ATTRIBUTES
                        else -> SimpleTextAttributes.REGULAR_ATTRIBUTES
                    }
                    append("#${node.id}  ${node.summary}", style)
                    val desc = node.reasoning?.lineSequence()?.firstOrNull()
                        ?: if (node.flags.isNotEmpty()) "${node.flags.size} flag(s)" else ""
                    if (desc.isNotBlank()) append("  $desc", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    toolTipText = buildString {
                        node.reasoning?.let { append("💭 $it\n") }
                        node.flags.forEach { append(if (it.level == "warn") "⚠ " else "ℹ ").append(it.message).append('\n') }
                        if (node.memorySummary.isNotBlank()) append("🧠 ${node.memorySummary}\n")
                        append("Double-click for the full report.")
                    }
                }
            }
        }
    }
}
