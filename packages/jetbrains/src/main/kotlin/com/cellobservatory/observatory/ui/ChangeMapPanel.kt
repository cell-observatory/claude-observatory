package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ChatRef
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.ChangeMap
import com.cellobservatory.observatory.model.ChangeMapAgent
import com.cellobservatory.observatory.model.ChangeMapChapter
import com.cellobservatory.observatory.model.ChangeMapFile
import com.cellobservatory.observatory.model.ChangeMapModule
import com.cellobservatory.observatory.model.ChangeMapSummary
import com.cellobservatory.observatory.model.ChangeMapWorkflow
import com.cellobservatory.observatory.model.Collision
import com.cellobservatory.observatory.model.MtSubagent
import com.cellobservatory.observatory.model.MultitaskResult
import com.cellobservatory.observatory.model.SessionTask
import com.cellobservatory.observatory.model.MultitaskFilter
import com.cellobservatory.observatory.model.RunningAgent
import com.cellobservatory.observatory.model.WorkflowAgent
import com.cellobservatory.observatory.model.WorkflowRun
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.JBColor
import com.intellij.ui.OnePixelSplitter
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBList
import com.intellij.ui.treeStructure.Tree
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import com.intellij.util.ui.tree.TreeUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Container
import java.awt.Cursor
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.LayoutManager2
import java.awt.RenderingHints
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JPopupMenu
import javax.swing.JSeparator
import javax.swing.JTree
import javax.swing.ListCellRenderer
import javax.swing.ScrollPaneConstants
import javax.swing.SwingConstants
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreeCellRenderer
import javax.swing.tree.TreePath
import javax.swing.tree.TreeSelectionModel

// The product's review palette — same hexes the VS Code webview reads from --vscode-charts-*, so the
// two editors colour a status identically. (StatsPanel keeps its own file-private copies.)
private val CM_PENDING = JBColor(Color(0xD9A441), Color(0xD9A441))
private val CM_KEPT = JBColor(Color(0x3FB950), Color(0x3FB950))
private val CM_REVERTED = JBColor.GRAY
// The multitask palette — the same hexes the VS Code webview reads from --vscode-charts-* (extension.ts
// --mt-*): working/running BLUE, done GREEN, awaiting ORANGE, error RED, subagents PURPLE.
private val MT_ATTENTION = JBColor(Color(0xD9822B), Color(0xD9822B))
private val MT_WORKING = JBColor(Color(0x4C8BF5), Color(0x4C8BF5))
private val MT_DONE = JBColor(Color(0x3FB950), Color(0x3FB950))
private val MT_ERROR = JBColor(Color(0xE5534B), Color(0xE5534B))
private val MT_AGENT = JBColor(Color(0x9A6AC2), Color(0x9A6AC2))
private val MT_ADD = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_DONE)
private val MT_REM = SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ERROR)

/** The module strip shows at most this many segments; the churn-ranked tail merges into "+K more". */
private const val MAX_SEGMENTS = 11
/** Sentinel module id for the strip's merged overflow segment — never a real module, never clickable. */
private const val OVERFLOW_MODULE = "+more"

/** status → colour. "undone" surfaces as "reverted" grey, matching the VS Code renderer. */
private fun statusColor(status: String): JBColor = when (status) {
    "pending" -> CM_PENDING
    "undone" -> CM_REVERTED
    else -> CM_KEPT
}

/**
 * Overview (0.8.0 r3): a MASTER–DETAIL panel that folds the former standalone Multitasking window in.
 *
 * LEFT NAV — two tabs (Fleet · Workflows) over `multitask --json`:
 *   · Fleet     = running agents across every worktree-sibling (+ nested subagents), each with its live
 *                 phase, sparkline, ±lines, tokens, time, and risk; a live file-conflict strip below.
 *   · Workflows = the Claude Code Workflow runs — informative name, per-phase progress, ±lines/tokens/time.
 *   An Active-only toggle + Clear-completed (a dismiss, never a delete) filter both, display-only.
 *
 * RIGHT DETAIL — the change-map (named-chapter ribbon · module strip · churn-ranked file ledger) for the
 * SELECTED nav item, from `changemap --json`'s `agents[]` / `workflows[]`, joined by session / workflowId.
 * The default is the main/orchestrator session (the top-level map). The ribbon renders the change-map's
 * `chapters[]` — TOTAL as of 0.8.0 (core appends a synthesized session chapter for work outside any
 * to-do, so no "unassigned" row can render); ch.taskId is the strict task Accept/Reject/Clear resolve
 * against and is null on the synthesized/duplicate display-only rows (no destructive buttons there).
 *
 * Both payloads are aggregated in core (the single backend) — this panel only paints. Realtime rides on
 * the transcript watcher / store watcher via ObservatoryService.refresh. Parity with the VS Code Overview.
 */
class ChangeMapPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    /** What the right detail is showing. Preserved across refreshes; falls back to [Main] if it vanishes. */
    private sealed class NavSel {
        object Main : NavSel()
        data class Agent(val session: String) : NavSel()
        data class Workflow(val id: String) : NavSel()
    }

    /** A ribbon chapter picked for the top toolbar's chapter-scoped bulk actions, or null for session-wide.
     *  Carries the slice's resolved session so the scoped op targets the right session even on an agent
     *  slice (chapter.id === the strict taskId task-keep/undo/clear resolve against). */
    private data class PickedChapter(val session: String, val id: String, val title: String)

    @Volatile private var map: ChangeMap? = null
    private var selected: NavSel = NavSel.Main
    private var pickedChapter: PickedChapter? = null

    /** The Overview title-bar toolbars (one ActionToolbar per group), kept so a chapter pick / nav step can
     *  refresh their scoped labels + counters. */
    private var overviewToolbars: List<ActionToolbar> = emptyList()
    /** The shared step-through review nav bar (parity with the status-bar widget), hosted in this toolbar. */
    private val reviewNavBar = ReviewNavBar(project) { onNavChanged() }
    /** The live detail panel — kept so a nav step can refresh its bottom summary without a full rebuild. */
    private var currentDetail: AgentDetail? = null

    /** A Diff/File/Folder/Chapter nav step landed — refresh the scoped toolbar labels + counters AND the
     *  change-map bottom summary (which names the current chapter / folder scope). */
    private fun onNavChanged() {
        refreshOverviewToolbar()
        currentDetail?.refreshSummary()
    }

    // --- LEFT NAV: Fleet (agents + subagents) + Workflows (runs), over multitask --json ---
    private val fleetRoot = DefaultMutableTreeNode()
    private val fleetModel = DefaultTreeModel(fleetRoot)
    private val fleetTree = Tree(fleetModel).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No agents yet — this fills in as Claude Code sessions run in this repo's worktrees"
        cellRenderer = SparklineTreeRenderer(FleetRenderer())
    }
    private val workflowsRoot = DefaultMutableTreeNode()
    private val workflowsModel = DefaultTreeModel(workflowsRoot)
    private val workflowsTree = Tree(workflowsModel).apply {
        isRootVisible = false
        showsRootHandles = true
        selectionModel.selectionMode = TreeSelectionModel.SINGLE_TREE_SELECTION
        emptyText.text = "No workflow runs — Claude Code Workflow orchestrations appear here"
        cellRenderer = SparklineTreeRenderer(WorkflowRenderer())
    }
    // --- LEFT NAV, third tab: the session's numbered task list (TaskCreate/TaskUpdate) ---
    /** One Tasks-tab row: the task + its change-map chapter (per-task ±/edit counts), when it has one. */
    private data class TaskRow(val task: SessionTask, val chapter: ChangeMapChapter?)
    /** The "N done · show all" collapse row — completed tasks fold behind it (fleet dismiss pattern). */
    private data class DoneTasksToggle(val count: Int, val open: Boolean)
    private var tasksOpen = false
    private var lastTasks: List<SessionTask> = emptyList()
    private val tasksModel = javax.swing.DefaultListModel<Any>()
    private val tasksList = JBList(tasksModel).apply {
        emptyText.text = "No tasks — this session plans with a task list only when Claude creates one"
        cellRenderer = TaskRowRenderer()
    }

    // --- RIGHT DETAIL: the change-map for the selected nav item ---
    private val detailHost = JPanel(BorderLayout())

    // --- Active-only + Clear-completed (display-only; a thin filter over the same payload). Persist across
    //     repaints; default OFF. The dismissed sets HIDE completed items (never delete); reset on a session
    //     change. A dismissed item reappears if it goes active again. ---
    private var activeOnly = false
    private val dismissedAgents = HashSet<String>()
    private val dismissedWorkflows = HashSet<String>()
    private var lastResult: MultitaskResult? = null
    private var lastSelfSession: String? = null
    /** Suppress the tree selection listeners while we programmatically reload / restore selection. */
    private var suppressSel = false

    /** Workflow ids already seen in a payload — null until the FIRST payload seeds it, so opening the
     *  panel never steals focus; afterwards a newly-appeared RUNNING run auto-focuses (user request). */
    private var seenWorkflows: HashSet<String>? = null

    /** The left nav's Fleet · Workflows tabs — a field so a new workflow run can switch to Workflows. */
    private lateinit var navTabs: JBTabbedPane

    init {
        // (Live conflicts moved to the Actions panel in 0.8.3 — the fleet tab is just the tree now.)
        navTabs = JBTabbedPane().apply {
            // Each pane leads with a one-line description (VS Code .ov-desc parity) above its tree/list.
            addTab("Fleet", descPane("Every Claude agent working in this repo’s worktrees — live phase, tokens, and risk. Select one to map just its edits.", JBScrollPane(fleetTree)))
            setToolTipTextAt(0, "Running agents across every worktree — siblings + their subagents — with the live file-conflict strip below. Select one to map its changes.")
            addTab("Workflows", descPane("Multi-agent runs (an orchestrator and its subagents) — each run’s phases and the edits attributed to it.", JBScrollPane(workflowsTree)))
            setToolTipTextAt(1, "Claude Code Workflow runs — agents grouped by phase, with tokens/time/edits per run. Select one to map its changes.")
            addTab("Tasks", descPane("This session’s numbered task list (Claude’s TaskCreate/TaskUpdate plan) — with live statuses; each row joins its change-map chapter.", JBScrollPane(tasksList)))
            setToolTipTextAt(2, "The session's task list (Claude's numbered TaskCreate/TaskUpdate tasks) — live statuses; completed tasks leave the list when the runtime archives them.")
        }
        // Left nav (Fleet · Workflows) = 25% of the panel; the change-map detail takes the remaining 75%.
        val split = OnePixelSplitter(false, 0.25f).apply {
            firstComponent = navTabs
            secondComponent = detailHost
        }
        setContent(split)

        // Feed the shared nav bar the current session's change-map chapters — their editIds drive the
        // Chapter axis + the bottom summary's chapter scope (the status-bar host leaves this empty).
        reviewNavBar.chaptersProvider = { map?.chapters ?: emptyList() }
        // The Overview shows the RICH Diff/File counters (edit time · filename · edit count); the status bar
        // stays terse (VS Code parity — that detail rides only the Overview's counters).
        reviewNavBar.richCounters = true

        // TWO rows (user swap 2026-07-17, VS Code parity — its .ov-toolbar is a flex column-reverse):
        //   BOTTOM row = the review AXES: Diff · File · Folder · Chapter (one centered cluster, dividers between).
        //   TOP row (split) = controls: LEFT cluster = session selector + Accept All + Revert All +
        //     Clear Resolved + Export ; RIGHT cluster = Search · Active only | Spotlight · Refresh.
        // The nav-bar actions come from the shared ReviewNavBar (labels shown, like VS Code). Each cluster is
        // its own ActionToolbar so a chapter pick / nav step can refresh its scoped labels + counters.

        // --- BOTTOM row: the four review axes ---
        val diffGroup = DefaultActionGroup().apply {
            reviewNavBar.diffAxis().forEach(::add)
            add(reviewNavBar.keepAction()); add(reviewNavBar.undoAction())
            add(reviewNavBar.chatEditAction()); add(reviewNavBar.viewDiffAction())
        }
        val fileGroup = DefaultActionGroup().apply {
            reviewNavBar.fileAxis().forEach(::add)
            add(reviewNavBar.acceptFileAction()); add(reviewNavBar.rejectFileAction())
        }
        val folderGroup = DefaultActionGroup().apply {
            reviewNavBar.folderAxis().forEach(::add)
            add(reviewNavBar.acceptFolderAction()); add(reviewNavBar.rejectFolderAction())
        }
        val chapterGroup = DefaultActionGroup().apply {
            reviewNavBar.chapterAxis().forEach(::add)
            add(reviewNavBar.reviewChapterAction()); add(reviewNavBar.acceptChapterAction())
            add(reviewNavBar.rejectChapterAction()); add(reviewNavBar.chatChapterAction())
        }

        // --- TOP row LEFT cluster: session selector + session-wide bulk + Export. Bulk actions RETARGET to
        //     the picked ribbon chapter when one is selected (task-keep/undo/clear on chapter.id). ---
        val leftGroup = DefaultActionGroup().apply {
            add(sessionSelectorAction())
            add(bulkAction("Accept All", NavTint.ACCEPT_ALL, { "Accept All in “$it”" },
                { withSession { s -> ReviewOps.keepAll(project, s) } },
                { p -> ReviewOps.keepTask(project, p.session, p.id, p.title) }))
            add(bulkAction("Revert All", NavTint.REVERT_ALL, { "Revert All in “$it”" },
                { withSession { s -> ReviewOps.undoAll(project, s, service().log(), "this session") } },
                { p -> ReviewOps.undoTask(project, p.session, p.id, p.title) }))
            add(bulkAction("Clear Resolved", NavTint.CLEAR, { "Clear in “$it”" },
                {
                    withSession { s ->
                        val resolved = service().log().count { !it.pending }
                        if (resolved > 0) ReviewOps.clearResolved(project, s, resolved) else ReviewOps.notify(project, "No resolved edits to clear")
                    }
                },
                { p -> ReviewOps.clearTask(project, p.session, p.id, p.title) }))
            add(exportAction())
        }
        // --- TOP row RIGHT cluster: Search · Active only | Spotlight · Refresh ---
        val rightGroup = DefaultActionGroup().apply {
            add(reviewNavBar.searchAction())
            add(activeOnlyToggle())
            addSeparator()
            add(reviewNavBar.spotlightAction())
            add(action("Refresh", AllIcons.Actions.Refresh) { rebuild(force = true) })
        }

        fun mkTb(name: String, g: DefaultActionGroup): ActionToolbar =
            ActionManager.getInstance().createActionToolbar("ClaudeObservatoryOverview$name", g, true).apply {
                targetComponent = fleetTree
                component.isOpaque = false
            }
        val diffTb = mkTb("Diff", diffGroup)
        val fileTb = mkTb("File", fileGroup)
        val folderTb = mkTb("Folder", folderGroup)
        val chapterTb = mkTb("Chapter", chapterGroup)
        val leftTb = mkTb("Left", leftGroup)
        val rightTb = mkTb("Right", rightGroup)
        overviewToolbars = listOf(diffTb, fileTb, folderTb, chapterTb, leftTb, rightTb)

        // TOP row: left cluster pinned LEFT, right cluster pinned RIGHT while both fit; when the tool
        // window is too narrow for both, the right cluster WRAPS onto a second line (VS Code's
        // .ov-tbrow.split is flex-wrap: wrap + space-between). SplitWrapLayout does the fit-or-stack; the
        // width-change revalidate lets the host toolbar grow the extra row instead of clipping.
        val topRow = JPanel(SplitWrapLayout(JBUI.scale(3))).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            add(leftTb.component)  // child 0 = LEFT cluster
            add(rightTb.component) // child 1 = RIGHT cluster
            addComponentListener(object : ComponentAdapter() {
                private var lastWidth = -1
                override fun componentResized(e: ComponentEvent) {
                    val c = e.component
                    if (c.width != lastWidth) { lastWidth = c.width; c.revalidate() }
                }
            })
        }
        // BOTTOM row: the four axes as ONE centered cluster with a divider between each (glue on both ends).
        val bottomRow = JPanel(GridBagLayout()).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            var col = 0
            fun natural() = GridBagConstraints().apply { gridx = col++; gridy = 0; fill = GridBagConstraints.NONE; anchor = GridBagConstraints.CENTER }
            fun glue() = add(Box.createHorizontalGlue(), GridBagConstraints().apply { gridx = col++; gridy = 0; weightx = 1.0; fill = GridBagConstraints.HORIZONTAL })
            glue()
            listOf(diffTb, fileTb, folderTb, chapterTb).forEachIndexed { i, tb ->
                if (i > 0) add(navDivider(), natural())
                add(tb.component, natural())
            }
            glue()
        }
        toolbar = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            isOpaque = false
            border = JBUI.Borders.empty(2, 2)
            add(topRow)
            add(Box.createVerticalStrut(JBUI.scale(3)))
            add(bottomRow)
        }

        // Single-click a Fleet row → map that agent (a subagent maps its parent agent); a Workflows run →
        // map that workflow. Ignore programmatic reloads (suppressSel) and non-item rows (the filter banner).
        fleetTree.addTreeSelectionListener {
            if (suppressSel) return@addTreeSelectionListener
            when (val obj = (fleetTree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject) {
                is AgentRow -> selectDetail(NavSel.Agent(obj.agent.session))
                is SubRow -> selectDetail(NavSel.Agent(obj.session))
                else -> {}
            }
        }
        workflowsTree.addTreeSelectionListener {
            if (suppressSel) return@addTreeSelectionListener
            (workflowsTree.lastSelectedPathComponent as? DefaultMutableTreeNode)?.userObject
                ?.let { if (it is WfRunRow) selectDetail(NavSel.Workflow(it.id)) }
        }

        // Right-click a Fleet row → zero-token chat about that agent / subagent (clipboard-only on JetBrains).
        fleetTree.addMouseListener(object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) = maybePopup(e)
            override fun mouseReleased(e: MouseEvent) = maybePopup(e)
            private fun maybePopup(e: MouseEvent) {
                if (!e.isPopupTrigger) return
                val path = fleetTree.getPathForLocation(e.x, e.y) ?: return
                fleetTree.selectionPath = path
                popupFor((path.lastPathComponent as? DefaultMutableTreeNode)?.userObject)?.show(fleetTree, e.x, e.y)
            }
        })

        // Clicking the Tasks tab's "N done · show all" row folds/unfolds the completed tasks.
        tasksList.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                val i = tasksList.locationToIndex(e.point)
                if (i >= 0 && tasksModel.get(i) is DoneTasksToggle) {
                    tasksOpen = !tasksOpen
                    repaintTasks(lastTasks)
                }
            }
        })

        ObservatoryService.getInstance(project).addListener { rebuild() }
        rebuild()
    }

    private fun selectDetail(sel: NavSel) {
        if (sel != selected) pickedChapter = null // a new slice — drop any chapter scope
        selected = sel
        renderDetail()
        refreshOverviewToolbar()
    }

    /** Force the Overview toolbar to recompute its labels (chapter scope) + nav counters immediately. */
    @Suppress("DEPRECATION") // updateActionsImmediately: still the way to force a toolbar refresh
    private fun refreshOverviewToolbar() {
        overviewToolbars.forEach { it.updateActionsImmediately() }
    }

    /** A thin, fixed-height divider between the Overview toolbar groups — the Swing echo of .ov-nbsep. */
    private fun navDivider(): JComponent = JSeparator(SwingConstants.VERTICAL).apply {
        val d = Dimension(JBUI.scale(1), JBUI.scale(18))
        preferredSize = d
        minimumSize = d
        maximumSize = d
    }

    private fun popupFor(node: Any?): JPopupMenu? = when (node) {
        is AgentRow -> JPopupMenu().apply {
            add(menuItem("Chat About This Agent") {
                ReviewOps.chatContext(project, node.agent.session, ChatRef.Session, "agent ${node.agent.session.take(8)}")
            })
        }
        is SubRow -> JPopupMenu().apply {
            val label = node.sub.agentType ?: node.sub.description ?: node.sub.agentId.take(12)
            add(menuItem("Chat About This Subagent") {
                ReviewOps.chatContext(project, node.session, ChatRef.Agent(node.sub.agentId), "subagent $label")
            })
        }
        else -> null
    }

    private fun menuItem(text: String, run: () -> Unit) = javax.swing.JMenuItem(text).apply { addActionListener { run() } }

    // --- data: the SHARED throttled multitask/changemap views from ObservatoryService (0.8.0
    // stabilization: one CLI spawn per view per ~3s across ALL panels, instead of a fresh pair here on
    // every ~2s watcher tick). get() returns the latest cached view immediately and notifies the
    // service listeners when a fresh one lands — which re-enters rebuild() with the new data. ---

    private fun rebuild(force: Boolean = false) {
        val service = ObservatoryService.getInstance(project)
        val mt = service.multitask(force)
        val cm = service.changemap(force)
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            map = cm
            repaintNav(mt)
            renderDetail()
            refreshOverviewToolbar() // keep the nav counters + scoped labels live on store changes
        }
    }

    private fun repaintNav(res: MultitaskResult?) {
        // Reset the dismissed sets when the active session changes — a stale dismiss must never carry over.
        val self = res?.agents?.firstOrNull { it.self }?.session
        if (self != null && lastSelfSession != null && self != lastSelfSession) {
            dismissedAgents.clear(); dismissedWorkflows.clear(); seenWorkflows = null
        }
        if (self != null) lastSelfSession = self
        lastResult = res

        // Auto-focus a NEW workflow run: the first payload only seeds the seen-set (opening the panel
        // never steals focus); afterwards a newly-appeared RUNNING run switches the nav to Workflows and
        // selects it (restoreSelection highlights the row) — the detail then tracks the run's agents,
        // phases, and edits live via the shared throttled fetches.
        val wfs = res?.workflows ?: emptyList()
        val seen = seenWorkflows
        if (seen == null) {
            seenWorkflows = wfs.map { it.id }.toHashSet()
        } else {
            var fresh: String? = null
            for (w in wfs) if (seen.add(w.id) && w.running) fresh = w.id
            fresh?.let {
                selected = NavSel.Workflow(it)
                if (::navTabs.isInitialized) navTabs.selectedIndex = 1
            }
        }

        suppressSel = true
        fleetRoot.removeAllChildren()
        val collisionFiles = res?.collisions?.map { it.file }?.toHashSet() ?: emptySet()
        val allAgents = res?.agents ?: emptyList()
        val shown = allAgents.filter { MultitaskFilter.showAgent(it, activeOnly, dismissedAgents) }
        fleetInfoNode(allAgents, shown)?.let { fleetRoot.add(it) }
        shown.forEach { agent ->
            val collides = agent.files.any { it in collisionFiles }
            val agentNode = DefaultMutableTreeNode(AgentRow(agent, collides))
            agent.subagents.forEach { agentNode.add(DefaultMutableTreeNode(SubRow(agent.session, it))) }
            fleetRoot.add(agentNode)
        }
        fleetModel.reload()
        TreeUtil.expandAll(fleetTree)
        repaintWorkflows(res?.workflows)
        repaintTasks(res?.tasks ?: emptyList())
        restoreSelection()
        suppressSel = false
    }

    /** Paint the Tasks tab (the session's numbered task list, newest first) and badge the tab with
     *  done/total. Each row joins its change-map chapter by chapterId (tasks ARE chapters) for per-task
     *  ±/edits. Completed tasks fold behind a "N done · show all" row; Active-only hides them outright
     *  (the same semantics the fleet's filters use). */
    private fun repaintTasks(tasks: List<SessionTask>) {
        lastTasks = tasks
        val chBy = map?.chapters?.associateBy { it.id } ?: emptyMap()
        val (done, active) = tasks.partition { it.status == "completed" }
        tasksModel.clear()
        active.forEach { tasksModel.addElement(TaskRow(it, chBy[it.chapterId])) }
        if (!activeOnly && done.isNotEmpty()) {
            tasksModel.addElement(DoneTasksToggle(done.size, tasksOpen))
            if (tasksOpen) done.forEach { tasksModel.addElement(TaskRow(it, chBy[it.chapterId])) }
        }
        if (::navTabs.isInitialized && navTabs.tabCount > 2) {
            navTabs.setTitleAt(2, if (tasks.isEmpty()) "Tasks" else "Tasks ${done.size}/${tasks.size}")
        }
    }

    /** Paint the Workflows tab: one node per run — its INFORMATIVE name (description/summary) · agents ·
     *  tokens · time · ±lines · running/done — with its agents GROUPED BY PHASE, each agent showing its
     *  label + tokens/time/edits. Thin — builds userObject nodes; [WorkflowRenderer] paints them. */
    private fun repaintWorkflows(workflows: List<WorkflowRun>?) {
        workflowsRoot.removeAllChildren()
        val allWf = workflows ?: emptyList()
        val shownWf = allWf.filter { MultitaskFilter.showWorkflow(it, activeOnly, dismissedWorkflows) }
        workflowsInfoNode(allWf, shownWf)?.let { workflowsRoot.add(it) }
        shownWf.forEach { w ->
            val node = DefaultMutableTreeNode(WfRunRow(w))
            val grouped = HashSet<String>()
            w.phaseGroups.forEach { pg ->
                val phaseNode = DefaultMutableTreeNode(WfPhaseRow(pg.title, pg.done, pg.total))
                w.agents.filter { it.phase == pg.title }.forEach { a ->
                    phaseNode.add(DefaultMutableTreeNode(WfAgentRow(a)))
                    grouped.add(a.agentId)
                }
                node.add(phaseNode)
            }
            w.agents.filter { it.agentId !in grouped }.forEach { a -> node.add(DefaultMutableTreeNode(WfAgentRow(a))) }
            workflowsRoot.add(node)
        }
        workflowsModel.reload()
        TreeUtil.expandAll(workflowsTree)
    }

    /** Re-select the tree row for the current [selected] after a reload wiped the selection (best-effort). */
    private fun restoreSelection() {
        when (val sel = selected) {
            is NavSel.Agent -> childOf(fleetRoot) { it is AgentRow && it.agent.session == sel.session }
                ?.let { fleetTree.selectionPath = TreePath(it.path) }
            is NavSel.Workflow -> childOf(workflowsRoot) { it is WfRunRow && it.id == sel.id }
                ?.let { workflowsTree.selectionPath = TreePath(it.path) }
            NavSel.Main -> {}
        }
    }

    private fun childOf(root: DefaultMutableTreeNode, pred: (Any?) -> Boolean): DefaultMutableTreeNode? {
        for (i in 0 until root.childCount) {
            val n = root.getChildAt(i) as DefaultMutableTreeNode
            if (pred(n.userObject)) return n
        }
        return null
    }



    // --- the right detail: change-map for the selected nav item ---

    private fun renderDetail() {
        detailHost.removeAll()
        currentDetail = null
        try {
            val m = map
            val td = if (m == null) null else (tabDataFor(selected, m) ?: tabDataFor(NavSel.Main, m))
            if (td == null) {
                detailHost.add(emptyLabel("No edits in this session yet — this fills in as Claude edits files"), BorderLayout.CENTER)
            } else {
                val detail = AgentDetail(td)
                currentDetail = detail
                detailHost.add(detail, BorderLayout.CENTER)
            }
        } catch (t: Throwable) {
            // Never leave the detail blank — a paint failure must be visible here, not only in idea.log.
            Logger.getInstance(ChangeMapPanel::class.java).warn("Overview detail failed to render", t)
            detailHost.add(emptyLabel("Overview detail failed to render: ${t.message ?: t.javaClass.simpleName} — see idea.log"), BorderLayout.CENTER)
        }
        detailHost.revalidate()
        detailHost.repaint()
    }

    /** Join the nav selection to a change-map slice: Main → the top-level map; Agent → its `agents[]` entry;
     *  Workflow → its `workflows[]` entry. Returns null when the selected item has no slice (caller falls
     *  back to Main). */
    private fun tabDataFor(sel: NavSel, m: ChangeMap): TabData? = when (sel) {
        NavSel.Main ->
            if (m.summary == null && m.files.isEmpty() && m.chapters.isEmpty()) null
            else TabData(
                session = m.summary?.session ?: "", summary = m.summary, files = m.files, modules = m.modules,
                chapters = m.chapters,
            )
        is NavSel.Agent -> m.agents.firstOrNull { it.session == sel.session }?.let { agentTabData(it) }
        is NavSel.Workflow -> m.workflows.firstOrNull { it.id == sel.id }?.let { workflowTabData(it, m) }
    }

    private fun agentTabData(a: ChangeMapAgent) = TabData(
        session = a.session, summary = a.summary, files = a.files, modules = a.modules,
        chapters = a.chapters,
    )

    /** One workflow's detail: a synthetic summary from its rollup, its churn-ranked touched files, and its
     *  OWN chapter ribbon (w.chapters — the run's edits regrouped by session chapter, aggregated in core).
     *  Total chapters partition the run exactly, so the old residual "unassigned" math is gone. */
    private fun workflowTabData(w: ChangeMapWorkflow, m: ChangeMap): TabData {
        val r = w.rollup
        val summary = ChangeMapSummary(
            session = m.summary?.session ?: "", title = m.summary?.title, units = r.edits, pending = r.pending, kept = r.kept, undone = r.undone,
            added = r.added, removed = r.removed, errors = 0, subagents = 0, fleet = 0, egress = 0,
        )
        return TabData(
            session = m.summary?.session ?: "", summary = summary, files = w.files, modules = emptyList(),
            chapters = w.chapters,
            running = w.running,
        )
    }

    private fun emptyLabel(text: String): JComponent = JBLabel(text).apply {
        border = JBUI.Borders.empty(12)
        foreground = UIUtil.getContextHelpForeground()
    }

    /** A left-nav pane with a one-line muted description above its content (the VS Code .ov-desc). */
    private fun descPane(desc: String, content: JComponent): JComponent = JPanel(BorderLayout()).apply {
        val label = JBLabel("<html>$desc</html>").apply {
            font = JBUI.Fonts.smallFont()
            foreground = UIUtil.getContextHelpForeground()
            border = JBUI.Borders.empty(4, 6, 5, 6)
        }
        add(label, BorderLayout.NORTH)
        add(content, BorderLayout.CENTER)
    }

    /** The session selector — shows the human-readable session NAME in FULL (title / first prompt), the
     *  raw id in the tooltip (VS Code parity, 2026-07-17); clicking it opens the Switch-session chooser. */
    private fun sessionSelectorAction(): AnAction = object : AnAction("Session", null, AllIcons.Vcs.Branch), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
        @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the session name
        override fun displayTextInToolbar() = true
        override fun update(e: AnActionEvent) {
            val title = map?.summary?.title?.takeIf { it.isNotBlank() }
            val sess = map?.summary?.session?.takeIf { it.isNotBlank() } ?: service().currentSession()
            e.presentation.text = title ?: ("session " + (sess?.take(8) ?: "—"))
            e.presentation.description = (title?.let { "$it — " } ?: "") + "session ${sess ?: "—"} · click to switch"
        }
        override fun actionPerformed(e: AnActionEvent) = ReviewOps.chooseSession(project, fleetTree)
    }

    /** Export — a shareable review summary (kept / reverted per file) as markdown, opened in an editor tab
     *  (mirrors the VS Code exportSummary; core.reviewSummaryMarkdown via `summary --markdown`). */
    private fun exportAction(): AnAction =
        action("Export", NavTint.tint(AllIcons.ToolbarDecorator.Export, NavTint.BLUE), "Export a shareable review summary (kept / reverted per file) as markdown") {
            withSession { s ->
                ReviewOps.openMarkdown(
                    project, "claude-observatory-review-summary",
                    "Could not export the review summary (is the claude-observatory CLI installed?)",
                ) { ObservatoryCli.summaryMarkdown(s, project.basePath) }
            }
        }

    /** An Overview-toolbar button: [text] renders beside the icon (VS Code shows these labels), with an
     *  optional longer [description] as the tooltip. */
    private fun action(text: String, icon: Icon, description: String? = null, run: () -> Unit): AnAction =
        object : AnAction(text, description, icon), DumbAware {
            @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the label
            override fun displayTextInToolbar() = true
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** A top-toolbar bulk action that RETARGETS to the picked ribbon chapter when one is selected: it runs
     *  [chapterRun] against that chapter (task-keep/undo/clear on chapter.id) and presents [scopedText];
     *  with nothing picked it runs [sessionRun] session-wide and presents [baseText]. */
    private fun bulkAction(
        baseText: String,
        icon: Icon,
        scopedText: (String) -> String,
        sessionRun: () -> Unit,
        chapterRun: (PickedChapter) -> Unit,
    ): AnAction = object : AnAction(baseText, null, icon), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
        @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the scoped label
        override fun displayTextInToolbar() = true
        override fun update(e: AnActionEvent) {
            val pick = pickedChapter
            e.presentation.text = if (pick != null) scopedText(pick.title) else baseText
        }

        override fun actionPerformed(e: AnActionEvent) {
            val pick = pickedChapter
            if (pick != null) chapterRun(pick) else sessionRun()
        }
    }

    private fun service() = ObservatoryService.getInstance(project)

    /** Run [block] with the active session, or warn if there is none — mirrors ObservationsPanel.withSession. */
    private fun withSession(block: (String) -> Unit) {
        val s = service().currentSession()
        if (s == null) {
            ReviewOps.notify(project, "No active Claude Code session for this project", com.intellij.notification.NotificationType.WARNING)
            return
        }
        block(s)
    }

    // --- Active-only + Clear-completed toolbar actions (apply to the Fleet + Workflows nav). Display-only. ---

    // The Active-only / Clear-completed classification lives in model.MultitaskFilter — the shared
    // Kotlin port of VS Code's canonical multitaskFilter (pinned by MultitaskFilterTest, no drift).
    private fun agentActive(a: RunningAgent) = MultitaskFilter.agentActive(a)

    private fun activeOnlyToggle(): ToggleAction = object : ToggleAction(
        "Active Only",
        "Show only active agents (working / awaiting input / awaiting permission, or with an active subagent) and running workflows",
        AllIcons.General.Filter,
    ), DumbAware {
        override fun getActionUpdateThread() = ActionUpdateThread.EDT
        @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the label
        override fun displayTextInToolbar() = true
        override fun isSelected(e: AnActionEvent) = activeOnly
        override fun setSelected(e: AnActionEvent, state: Boolean) {
            activeOnly = state
            repaintNav(lastResult)
        }
    }

    private fun fleetInfoNode(all: List<RunningAgent>, shown: List<RunningAgent>): DefaultMutableTreeNode? {
        val hidden = all.count { it.session in dismissedAgents && !agentActive(it) }
        val parts = mutableListOf<String>()
        if (activeOnly) parts += "Active only — showing ${shown.size} of ${all.size} agent${if (all.size == 1) "" else "s"}"
        if (hidden > 0) parts += "$hidden hidden — Show Hidden to restore"
        return if (parts.isEmpty()) null else DefaultMutableTreeNode(FilterInfo(parts.joinToString("  ·  ")))
    }

    private fun workflowsInfoNode(all: List<WorkflowRun>, shown: List<WorkflowRun>): DefaultMutableTreeNode? {
        val hidden = all.count { it.id in dismissedWorkflows && !it.running }
        val parts = mutableListOf<String>()
        if (activeOnly) parts += "Active only — showing ${shown.size} of ${all.size} workflow${if (all.size == 1) "" else "s"}"
        if (hidden > 0) parts += "$hidden hidden — Show Hidden to restore"
        return if (parts.isEmpty()) null else DefaultMutableTreeNode(FilterInfo(parts.joinToString("  ·  ")))
    }

    // --- nav node userObjects ---

    private class AgentRow(val agent: RunningAgent, val collides: Boolean)
    private class SubRow(val session: String, val sub: MtSubagent)
    private class WfRunRow(val run: WorkflowRun) {
        val id: String get() = run.id
    }
    private class WfPhaseRow(val title: String, val done: Int, val total: Int)
    private class WfAgentRow(val agent: WorkflowAgent)
    private class FilterInfo(val text: String) {
        override fun toString(): String = text
    }

    private class FleetRenderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is AgentRow -> renderAgent(node)
                is SubRow -> renderSubagent(node.sub)
                is FilterInfo -> {
                    icon = AllIcons.General.Filter
                    append(node.text, SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
            }
        }

        private fun renderAgent(node: AgentRow) {
            val a = node.agent
            val (glyph, attrs) = phaseBadge(a.phase)
            icon = phaseIcon(a.phase)
            // A '~' marks a staleness-INFERRED phase (awaiting-permission/idle/done have no structural
            // marker) — parity with the VS Code badge; the tooltip carries the explanation.
            val heuristic = a.phaseConfidence == "heuristic"
            val head = (if (a.self) "(you) " else "") + a.gitBranch.ifBlank { a.session.take(8) }
            append("$glyph${if (heuristic) "~" else ""} ", attrs)
            append("$head  ", SimpleTextAttributes.REGULAR_ATTRIBUTES)
            append(baseName(a.worktree), SimpleTextAttributes.GRAYED_ATTRIBUTES)
            if (a.added > 0 || a.removed > 0) {
                append("  +${a.added}", MT_ADD)
                append(" −${a.removed}", MT_REM)
            }
            // 0.8.0: tokens + wall-clock, the same metric style Workflows already show.
            if (a.tokens > 0 || a.durationMs > 0) append("  ${fmtTok(a.tokens)} tok · ${fmtDur(a.durationMs)}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            if (a.riskTotal > 0) append("  ⚠ ${if (a.riskHigh > 0) "${a.riskHigh} high" else "${a.riskTotal}"}",
                if (a.riskHigh > 0) SimpleTextAttributes.ERROR_ATTRIBUTES else SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ATTENTION))
            if (node.collides) append("  ⛒ collision", SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ATTENTION))
            toolTipText = buildString {
                append(if (a.self) "This session: " else "Agent: ").append(a.session).append("\n")
                append("phase ${a.phase}").append(if (heuristic) " (~ inferred from inactivity)" else "").append("\n")
                append("worktree ${a.worktree}").append("  ·  branch ${a.gitBranch}").append("\n")
                append("${fmtTok(a.tokens)} tok · ${fmtDur(a.durationMs)}")
                if (a.todos.isNotEmpty()) {
                    val cur = a.todos.firstOrNull { it.status == "in_progress" } ?: a.todos.lastOrNull()
                    cur?.let { append("\ntask: ${it.content}") }
                }
                append("\nSelect to map this agent's changes on the right")
            }
        }

        private fun renderSubagent(s: MtSubagent) {
            val (glyph, _) = phaseBadge(s.phase)
            icon = phaseIcon(s.phase)
            val heuristic = s.phaseConfidence == "heuristic"
            val title = s.agentType ?: s.description ?: s.agentId.take(12)
            // Subagent identity in PURPLE — the VS Code webview's --mt-agent accent.
            append(title, SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_AGENT))
            append("  $glyph ${s.phase}${if (heuristic) "~" else ""}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
            s.currentTask?.takeIf { it.isNotBlank() }?.let { append("  · ${clip(it, 48)}", SimpleTextAttributes.GRAYED_ATTRIBUTES) }
            if (s.edits > 0 || s.added > 0 || s.removed > 0) {
                append("  +${s.added}", MT_ADD)
                append(" −${s.removed}", MT_REM)
            }
            toolTipText = buildString {
                append(title)
                if (s.description != null && s.agentType != null) append("\n${s.description}")
                append("\nphase ${s.phase}${if (heuristic) " (~ inferred from inactivity)" else ""} · agent ${s.agentId}")
                if (s.todos.isNotEmpty()) {
                    append("\n")
                    s.todos.take(8).forEach { append("\n• [${it.status}] ${it.content}") }
                }
            }
        }

        private fun phaseIcon(phase: String): Icon = when (phase) {
            "working" -> AllIcons.Actions.Execute
            "awaiting-input", "awaiting-permission" -> AllIcons.General.BalloonWarning
            "errored" -> AllIcons.General.Error
            "done" -> AllIcons.Actions.Commit
            else -> AllIcons.Actions.Pause
        }
    }

    /** Paints the Workflows tab (mirrors [FleetRenderer]): a run row = status badge + INFORMATIVE name +
     *  GRAYED metrics; a phase row = "Title done/total"; an agent row = done-dot · label (a trailing '~'
     *  marks a prompt-derived label, same convention as phases) · GRAYED metrics. The activity sparkline
     *  is painted beside the row by [SparklineTreeRenderer]. */
    private class WorkflowRenderer : ColoredTreeCellRenderer() {
        override fun customizeCellRenderer(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ) {
            when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is WfRunRow -> renderRun(node.run)
                is WfPhaseRow -> {
                    append(node.title, SimpleTextAttributes.REGULAR_ATTRIBUTES)
                    append("  ${node.done}/${node.total}",
                        if (node.done >= node.total) SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_DONE) else SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
                is WfAgentRow -> renderAgent(node.agent)
                is FilterInfo -> {
                    icon = AllIcons.General.Filter
                    append(node.text, SimpleTextAttributes.GRAYED_ATTRIBUTES)
                }
            }
        }

        private fun renderRun(w: WorkflowRun) {
            if (w.running) append("▶ running  ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_WORKING))
            else append("✓ done  ", SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_DONE))
            val name = w.description?.takeIf { it.isNotBlank() } ?: w.name
            append(clip(name, 64), SimpleTextAttributes.REGULAR_ATTRIBUTES)
            append("  ${w.agentCount} ag · ${fmtTok(w.tokens)} tok · ${fmtDur(w.durationMs)}", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            append("  +${w.added}", MT_ADD)
            append(" −${w.removed}", MT_REM)
            toolTipText = buildString {
                append(name)
                if (w.phaseGroups.isNotEmpty()) append("\n" + w.phaseGroups.joinToString(" · ") { "${it.title} ${it.done}/${it.total}" })
                append("\nSelect to map this run's changes on the right")
            }
        }

        private fun renderAgent(a: WorkflowAgent) {
            // Done dot GREEN, running dot BLUE — the same state colors the VS Code agent rows use.
            append(if (a.done) "● " else "○ ",
                SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, if (a.done) MT_DONE else MT_WORKING))
            // A '~' marks a prompt-derived (heuristic) label on a live run — same convention as phases.
            val who = a.label?.let { it + if (a.labelDerived) "~" else "" } ?: "${a.agentType ?: "agent"} ${a.agentId.take(8)}"
            append(clip(who, 48), SimpleTextAttributes.REGULAR_ATTRIBUTES)
            if (a.added > 0 || a.removed > 0) {
                append("  +${a.added}", MT_ADD)
                append(" −${a.removed}", MT_REM)
            }
            val mdl = if (a.model.isNotBlank()) "${a.model} · " else ""
            append("  $mdl${fmtTok(a.tokens)} tok · ${fmtDur(a.durationMs)} · ${a.edits} edit${if (a.edits == 1) "" else "s"}",
                SimpleTextAttributes.GRAYED_ATTRIBUTES)
            toolTipText = who
        }
    }

    /** Paints one Tasks-tab row: status glyph (the fleet's state colors) · #id · subject (struck through
     *  when completed) · per-task ±/edits from its chapter · the in-progress activeForm · a blocked-by
     *  note. Tooltip = the description. */
    private class TaskRowRenderer : com.intellij.ui.ColoredListCellRenderer<Any>() {
        override fun customizeCellRenderer(
            list: javax.swing.JList<out Any>, value: Any?, index: Int, selected: Boolean, hasFocus: Boolean,
        ) {
            if (value is DoneTasksToggle) {
                append("${value.count} done · ${if (value.open) "hide" else "show all"}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                toolTipText = "Completed tasks fold here — click to ${if (value.open) "hide" else "show"} them"
                return
            }
            val row = value as? TaskRow ?: return
            val t = row.task
            val done = t.status == "completed"
            val wip = t.status == "in_progress"
            append(
                if (done) "● " else if (wip) "◐ " else "○ ",
                SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, if (done) MT_DONE else if (wip) MT_WORKING else JBColor.GRAY),
            )
            append("#${t.id}  ", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            append(
                clip(t.subject, 64),
                if (done) SimpleTextAttributes(SimpleTextAttributes.STYLE_STRIKEOUT, JBColor.GRAY) else SimpleTextAttributes.REGULAR_ATTRIBUTES,
            )
            row.chapter?.takeIf { it.edits > 0 }?.let { ch ->
                append("  +${ch.added}", MT_ADD)
                append(" −${ch.removed}", MT_REM)
                append(" · ${ch.edits} edit${if (ch.edits == 1) "" else "s"}" + if (ch.pending > 0) " · ${ch.pending} pending" else "", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
            }
            if (wip && t.activeForm != null) append("  ${t.activeForm}…", SimpleTextAttributes(SimpleTextAttributes.STYLE_ITALIC, MT_WORKING))
            if (t.blockedBy.isNotEmpty()) append("  blocked ×${t.blockedBy.size}", SimpleTextAttributes(SimpleTextAttributes.STYLE_PLAIN, MT_ATTENTION))
            toolTipText = t.description.ifBlank { t.subject }
        }
    }

    /** Wraps a tree cell renderer so rows that carry activity bins — fleet agents, workflow runs + their
     *  agents — get a painted [SparklineIcon] on the row's right edge. The panel stays non-opaque so the
     *  tree's wide-selection background shows through; the inner renderer's tooltip is forwarded. */
    private class SparklineTreeRenderer(private val inner: ColoredTreeCellRenderer) : TreeCellRenderer {
        private val spark = JLabel()
        private val panel = JPanel(BorderLayout(JBUI.scale(6), 0)).apply {
            isOpaque = false
            add(inner, BorderLayout.CENTER)
            add(spark, BorderLayout.EAST)
        }

        override fun getTreeCellRendererComponent(
            tree: JTree, value: Any?, selected: Boolean, expanded: Boolean,
            leaf: Boolean, row: Int, hasFocus: Boolean,
        ): Component {
            val c = inner.getTreeCellRendererComponent(tree, value, selected, expanded, leaf, row, hasFocus)
            val bins = when (val node = (value as? DefaultMutableTreeNode)?.userObject) {
                is AgentRow -> node.agent.sparkline
                is WfRunRow -> node.run.sparkline
                is WfAgentRow -> node.agent.sparkline
                else -> null
            }
            spark.icon = bins?.takeIf { b -> b.any { it > 0 } }?.let { SparklineIcon(it) }
            spark.isVisible = spark.icon != null
            panel.toolTipText = (c as? JComponent)?.toolTipText
            return panel
        }
    }

    /** The per-detail render inputs — one change-map slice (main session, a sibling agent, or a workflow). */
    private class TabData(
        val session: String,
        val summary: ChangeMapSummary?,
        val files: List<ChangeMapFile>,
        val modules: List<ChangeMapModule>,
        /** The named chapter ribbon — TOTAL for every slice kind (a workflow carries its own rollup). */
        val chapters: List<ChangeMapChapter>,
        /** Non-null on a workflow slice — its run state, shown as a badge in the chips row. */
        val running: Boolean? = null,
    )

    /** One slice's Overview detail: chips headline · named-chapter ribbon · module strip · churn ledger. */
    private inner class AgentDetail(private val data: TabData) : JPanel(BorderLayout()) {
        private var modFilter: String? = null

        // Scrollable + tracksViewportWidth so the ribbon fills its scroll pane's width — the empty-area
        // click (clear the chapter pick) and the picked-row highlight keep working edge to edge.
        private val ribbon = object : JPanel(), javax.swing.Scrollable {
            override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
            override fun getScrollableUnitIncrement(visible: java.awt.Rectangle, orientation: Int, direction: Int) = JBUI.scale(18)
            override fun getScrollableBlockIncrement(visible: java.awt.Rectangle, orientation: Int, direction: Int) = visible.height
            override fun getScrollableTracksViewportWidth() = true
            override fun getScrollableTracksViewportHeight() = false
        }.apply { layout = BoxLayout(this, BoxLayout.Y_AXIS); border = JBUI.Borders.empty(2, 0) }
        // The ribbon scrolls past ~150px instead of squeezing the ledger out (VS Code .cm-ribbon's
        // max-height + overflow-y:auto); hidden as a whole when the ribbon has no rows.
        private val ribbonScroll = JBScrollPane(
            ribbon, ScrollPaneConstants.VERTICAL_SCROLLBAR_AS_NEEDED, ScrollPaneConstants.HORIZONTAL_SCROLLBAR_NEVER,
        ).apply {
            border = JBUI.Borders.empty()
            isOpaque = false
            viewport.isOpaque = false
            maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(150))
        }
        private var ribOpen = false
        private val strip = StripBar()
        private val listModel = DefaultListModel<ChangeMapFile>()
        // Held directly — JBList wraps the assigned renderer (ExpandedItemListCellRendererWrapper), so
        // reading list.cellRenderer back would not return this instance.
        private val ledgerRenderer = LedgerRenderer()
        private val list = JBList(listModel).apply {
            cellRenderer = ledgerRenderer
            emptyText.text = "No edits attributed to this agent yet"
        }
        private val readout = JBLabel().apply { font = JBUI.Fonts.label(); foreground = UIUtil.getContextHelpForeground() }

        // Section captions (VS Code .cm-caption) + the bottom summary bar. The caption tooltips describe
        // each section; the summary names the current scope's pending/accepted/file/folder totals.
        private val capChapters = caption("Chapters", "Chapters — the subtasks (Claude’s to-dos / tasks) this work fell under. Each chip shows ±lines · edits · pending; click it to review that chapter in the nav bar.")
        private val capFolders = caption("Folders", "Folders — the directories Claude changed. Color = review status (amber pending · green kept · red reverted); click a tile to filter the files below and open that folder in the nav bar.")
        private val capFiles = caption("Files", "Files — every changed file, ranked by churn. Dot = review status, bar = relative churn, +N = lines, ⧗/✓ = pending/reviewed; click a row to open the edit.")
        private val summaryLabel = JBLabel().apply { font = JBUI.Fonts.miniFont(); border = JBUI.Borders.empty(2, 4, 2, 4) }
        private var lastShown: List<ChangeMapFile> = emptyList()

        private fun caption(text: String, tip: String): JBLabel = JBLabel(text).apply {
            font = JBUI.Fonts.miniFont()
            foreground = UIUtil.getContextHelpForeground()
            border = JBUI.Borders.empty(3, 1, 2, 0)
            toolTipText = tip
            alignmentX = Component.LEFT_ALIGNMENT
        }

        init {
            ribbonScroll.alignmentX = Component.LEFT_ALIGNMENT
            strip.alignmentX = Component.LEFT_ALIGNMENT
            val north = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                border = JBUI.Borders.empty(2, 4)
                add(capChapters)   // above the Chapters ribbon
                add(ribbonScroll)
                add(capFolders)    // above the Folders strip
                add(strip)
                add(capFiles)      // above the Files ledger (which is the CENTER list below)
            }
            add(north, BorderLayout.NORTH)
            add(JBScrollPane(list), BorderLayout.CENTER)
            val south = JPanel().apply {
                layout = BoxLayout(this, BoxLayout.Y_AXIS)
                readout.alignmentX = Component.LEFT_ALIGNMENT
                summaryLabel.alignmentX = Component.LEFT_ALIGNMENT
                add(readout)
                add(summaryLabel)
            }
            add(south, BorderLayout.SOUTH)

            // Click a folder tile → filter the ledger to it AND jump the nav-bar Folder axis there (open its
            // first pending edit) — VS Code parity (revealFolder).
            strip.onClick = { mod ->
                val selecting = modFilter != mod
                modFilter = if (selecting) mod else null
                paintTab()
                if (selecting) reviewNavBar.revealFolder(mod)
            }
            list.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (e.clickCount != 2) return
                    val f = list.selectedValue ?: return
                    if (f.maxId < 0 || data.session.isBlank()) return
                    val rec = StoreReader.findRecord(data.session, f.maxId) ?: return
                    Navigate.openFileAtEdit(project, data.session, rec)
                }
            })
            // Click the ribbon's empty area → clear any chapter scope (back to session-wide bulk actions).
            ribbon.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (pickedChapter != null) { pickedChapter = null; paintTab(); refreshOverviewToolbar() }
                }
            })
            paintTab()
        }

        private fun paintTab() {
            // Drop a chapter pick whose chapter no longer exists in this slice (accepted-away / switched).
            // Picks are keyed by the CHAPTER id — the WYSIWYG key reviewEditIds resolves (synthetic incl.).
            pickedChapter?.let { p -> if (data.chapters.none { it.id == p.id }) pickedChapter = null }

            // The ribbon — named chapters as a VERTICAL stacked list (one chapter per row: dot · title ·
            // ±counts · Accept/Reject/Clear). Chapters are TOTAL (0.8.0): core appends a synthetic session
            // chapter for work outside any to-do, so no "unassigned" row exists in ANY slice — agent, main,
            // or workflow (a workflow carries its own core-built chapter rollup). Settled ("done") chapters
            // collapse behind a "N done" toggle so many stay readable.
            ribbon.removeAll()
            val done = ArrayList<ChangeMapChapter>()
            data.chapters.forEach { ch ->
                // Task-born chapters live on the Tasks tab — never duplicate them here (VS Code parity);
                // and planned zero-edit rows stay hidden like VS Code's ribbon filter.
                if (ch.fromTask) return@forEach
                if (ch.edits == 0 && ch.status != "wip") return@forEach
                if (ch.edits > 0 && ch.pending == 0 && ch.undone == 0) done.add(ch) else ribbon.add(chapterRow(ch))
            }
            if (done.isNotEmpty()) {
                ribbon.add(doneToggle(done.size))
                if (ribOpen) done.forEach { ribbon.add(chapterRow(it)) }
            }
            ribbonScroll.isVisible = ribbon.componentCount > 0
            capChapters.isVisible = ribbonScroll.isVisible

            strip.isVisible = data.modules.isNotEmpty()
            capFolders.isVisible = strip.isVisible
            strip.update(data.modules, modFilter)

            // The Search-edits filter narrows this ledger too (parity with the sidebar trees + VS Code).
            val q = ObservatoryService.getInstance(project).filterQuery
            val shown = data.files.filter {
                (modFilter == null || it.moduleLabel == modFilter) &&
                    (q.isBlank() || it.rel.contains(q, ignoreCase = true))
            }
            lastShown = shown
            capFiles.isVisible = shown.isNotEmpty()
            listModel.clear()
            val max = shown.maxOfOrNull { maxOf(1, it.churn) } ?: 1
            ledgerRenderer.configure(max.coerceAtLeast(1))
            shown.forEach { listModel.addElement(it) }

            // Say WHY the ledger is narrowed — a silently filtered-empty list reads as a bug.
            val notes = mutableListOf<String>()
            modFilter?.let { mf -> data.modules.find { it.module == mf }?.let { notes.add("module ${it.label} — click again to clear") } }
            if (q.isNotBlank()) notes.add("search “$q” · ${shown.size} file(s) — Search again (empty) to clear")
            readout.text = notes.joinToString("  ·  ")

            refreshSummary()
            ribbon.revalidate(); ribbon.repaint()
            strip.repaint()
            revalidate(); repaint()
        }

        /** The bottom summary bar: for the CURRENT scope, `[name ·] N pending · N accepted · [N reverted ·]
         *  N files · N folders`. Scope precedence (VS Code renderSummary): a picked chapter chip → else the
         *  nav-bar Chapter axis's current chapter (unless a folder tile filters) → else an active folder
         *  filter → else the whole visible view. A chapter/folder scope is NAMED; the whole view is unnamed. */
        fun refreshSummary() {
            val chapters = data.chapters
            val navCh = if (modFilter == null) reviewNavBar.currentChapterId() else null
            val chId = pickedChapter?.id ?: navCh
            val ch = chId?.let { id -> chapters.firstOrNull { it.id == id } }
            val sp: Int; val sk: Int; val su: Int; val nfiles: Int; val folders: Set<String>; val name: String?
            if (ch != null) {
                val seen = HashSet<String>()
                val fol = HashSet<String>()
                var nf = 0
                for (f in data.files) if (f.chapters.contains(ch.id) && seen.add(f.rel)) { nf++; fol.add(f.moduleLabel) }
                sp = ch.pending; sk = ch.kept; su = ch.undone; nfiles = nf; folders = fol
                name = ch.title.ifBlank { null }
            } else {
                sp = lastShown.sumOf { it.pending }; sk = lastShown.sumOf { it.kept }; su = lastShown.sumOf { it.undone }
                nfiles = lastShown.size; folders = lastShown.map { it.moduleLabel }.toHashSet(); name = modFilter
            }
            if (name == null && nfiles == 0) { summaryLabel.text = ""; return }
            val parts = mutableListOf<String>()
            name?.let { parts.add("<b style='color:#4C8BF5'>${escHtml(it)}</b>") }
            parts.add("<b style='color:#D9A441'>$sp</b> pending")
            parts.add("<b style='color:#3FB950'>$sk</b> accepted")
            if (su > 0) parts.add("<b style='color:#8C8C8C'>$su</b> reverted")
            parts.add("<b>$nfiles</b> file${if (nfiles == 1) "" else "s"}")
            parts.add("<b>${folders.size}</b> folder${if (folders.size == 1) "" else "s"}")
            summaryLabel.text = "<html>${parts.joinToString(" · ")}</html>"
        }

        private fun rowPanel(): JPanel = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(4), JBUI.scale(1))).apply {
            isOpaque = false
            alignmentX = Component.LEFT_ALIGNMENT
            maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(24))
        }

        private fun miniButton(icon: Icon, tip: String, run: () -> Unit): JComponent =
            javax.swing.JButton(icon).apply {
                toolTipText = tip
                margin = JBUI.insets(0, 3)
                isFocusable = false
                putClientProperty("JButton.buttonType", "square")
                addActionListener { run() }
            }

        private fun withSession(run: (String) -> Unit) {
            val s = data.session.takeIf { it.isNotBlank() }
                ?: ObservatoryService.getInstance(project).currentSession()
            if (s == null) ReviewOps.notify(project, "No active Claude Code session for this project", com.intellij.notification.NotificationType.WARNING)
            else run(s)
        }

        /** Toggle the picked ribbon chapter, capturing this slice's session so the top toolbar's scoped
         *  bulk actions target the right session; re-picking or clicking empty ribbon clears the scope. */
        private fun toggleChapterPick(id: String, title: String) {
            if (pickedChapter?.id == id) {
                pickedChapter = null
            } else {
                val sess = data.session.takeIf { it.isNotBlank() }
                    ?: ObservatoryService.getInstance(project).currentSession()
                if (sess == null) {
                    ReviewOps.notify(project, "No active Claude Code session for this project", com.intellij.notification.NotificationType.WARNING)
                    return
                }
                pickedChapter = PickedChapter(sess, id, title)
                reviewNavBar.revealChapter(id) // jump the nav-bar Chapter axis to this chapter (VS Code parity)
            }
            paintTab()
            refreshOverviewToolbar()
        }

        /** One chapter row: [status dot] [title] [±counts] [Accept] [Reject] [Clear]. The actions
         *  and the scoped pick key on ch.id and act WYSIWYG — core.reviewEditIds resolves exactly the
         *  edits the row displays (the synthetic session chapter included, so a fully-reviewable ribbon).
         *  A planned (edits==0) chapter is an informational ○ row. */
        private fun chapterRow(ch: ChangeMapChapter): JComponent {
            val (glyph, color) = when {
                ch.edits == 0 -> "○" to UIUtil.getContextHelpForeground()
                ch.pending > 0 -> "◐" to CM_PENDING
                ch.undone > 0 -> "◑" to UIUtil.getContextHelpForeground()
                else -> "●" to CM_KEPT
            }
            val title = ch.title.ifBlank { "chapter ${ch.index + 1}" }
            val actable = ch.edits > 0
            val picked = pickedChapter?.id == ch.id
            val row = rowPanel()
            if (picked) {
                // Selected-chapter highlight — the top toolbar's bulk actions now scope to this chapter.
                row.isOpaque = true
                row.background = UIUtil.getListSelectionBackground(false)
            }
            row.add(JBLabel(glyph).apply { font = JBUI.Fonts.label(); foreground = color })
            row.add(JBLabel(clipText(title + (if (ch.agent) " ●" else ""), 44)).apply {
                font = JBUI.Fonts.label()
                if (ch.synthetic) foreground = UIUtil.getContextHelpForeground() // dimmed — display-only
                toolTipText = buildString {
                    append(title)
                    if (ch.synthetic) append("\nwork outside any to-do — attributed to the session")
                    if (ch.edits > 0) {
                        append("\n${ch.edits} edit(s) · +${ch.added} -${ch.removed}")
                        if (ch.pending > 0) append(" · ${ch.pending} pending")
                        if (ch.kept > 0) append(" · ${ch.kept} kept")
                        if (ch.undone > 0) append(" · ${ch.undone} reverted")
                    } else {
                        append("\nplanned — no attributed edits yet")
                    }
                    if (actable) {
                        append("\nClick to " + (if (picked) "clear the scope" else "scope the toolbar's bulk actions to this chapter"))
                        append("\nRight-click to accept / reject / clear this chapter")
                    }
                }
                if (actable) {
                    addMouseListener(chapterMenu(ch.id, title))
                    // Left-click a chapter with edits → pick it for the toolbar's chapter-scoped bulk actions
                    // (click again, or empty ribbon, to clear). Planned (edits==0) chapters stay informational.
                    cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                    addMouseListener(object : MouseAdapter() {
                        override fun mouseClicked(e: MouseEvent) {
                            if (e.button == MouseEvent.BUTTON1) toggleChapterPick(ch.id, title)
                        }
                    })
                }
            })
            if (ch.edits > 0) {
                row.add(JBLabel("+${ch.added} −${ch.removed}").apply { font = JBUI.Fonts.miniFont(); foreground = UIUtil.getContextHelpForeground() })
            }
            if (actable) {
                // The chips ARE the bulk actions retargeted to this chapter — same glyphs + tints as the
                // toolbar's Accept All / Revert All / Clear Resolved (VS Code chip parity, one icon per action).
                row.add(miniButton(NavTint.ACCEPT_ALL, "Accept — keep the pending edits shown in this chapter") { withSession { s -> ReviewOps.keepTask(project, s, ch.id, title) } })
                row.add(miniButton(NavTint.REVERT_ALL, "Reject — revert the pending edits shown in this chapter") { withSession { s -> ReviewOps.undoTask(project, s, ch.id, title) } })
                row.add(miniButton(NavTint.CLEAR, "Clear — drop this chapter's resolved edits") { withSession { s -> ReviewOps.clearTask(project, s, ch.id, title) } })
            }
            return row
        }

        /** Right-click context menu on a chapter row: Accept / Reject / Clear — WYSIWYG over the
         *  chapter's DISPLAYED edit set (keyed by ch.id; the synthetic session chapter included). */
        private fun chapterMenu(taskId: String, title: String) = object : MouseAdapter() {
            override fun mousePressed(e: MouseEvent) = maybePopup(e)
            override fun mouseReleased(e: MouseEvent) = maybePopup(e)
            private fun maybePopup(e: MouseEvent) {
                if (!e.isPopupTrigger) return
                val session = data.session.takeIf { it.isNotBlank() }
                    ?: ObservatoryService.getInstance(project).currentSession() ?: return
                javax.swing.JPopupMenu().apply {
                    add(menuItem("Accept — keep this chapter's pending edits") { ReviewOps.keepTask(project, session, taskId, title) })
                    add(menuItem("Reject — revert this chapter's pending edits") { ReviewOps.undoTask(project, session, taskId, title) })
                    add(menuItem("Clear — drop this chapter's resolved edits") { ReviewOps.clearTask(project, session, taskId, title) })
                }.show(e.component, e.x, e.y)
            }
        }

        private fun menuItem(text: String, run: () -> Unit) =
            javax.swing.JMenuItem(text).apply { addActionListener { run() } }

        /** The collapse/expand toggle row for settled ("done") chapters, plus a "clear completed" affordance. */
        private fun doneToggle(count: Int): JComponent {
            val row = rowPanel()
            row.add(JBLabel("● $count done").apply {
                font = JBUI.Fonts.label()
                foreground = CM_KEPT
                icon = if (ribOpen) AllIcons.General.ArrowDown else AllIcons.General.ArrowRight
                horizontalTextPosition = SwingConstants.LEADING // the caret icon trails the text
                cursor = Cursor.getPredefinedCursor(Cursor.HAND_CURSOR)
                toolTipText = "$count completed chapter(s) — click to ${if (ribOpen) "collapse" else "expand"}"
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) { ribOpen = !ribOpen; paintTab() }
                })
            })
            row.add(miniButton(AllIcons.Actions.GC, "Clear resolved edits of every completed chapter") {
                withSession { s -> ReviewOps.clearCompletedChapters(project, s) }
            })
            return row
        }

        /** The one-row module proportion strip: equal-width clickable chips, colour = worst-unreviewed-wins. */
        private inner class StripBar : JComponent() {
            private var mods: List<ChangeMapModule> = emptyList()
            private var sel: String? = null
            private var hit: List<Triple<Int, Int, ChangeMapModule>> = emptyList()
            var onClick: ((String) -> Unit)? = null

            init {
                preferredSize = Dimension(JBUI.scale(200), JBUI.scale(18))
                maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(18))
                minimumSize = Dimension(JBUI.scale(60), JBUI.scale(18))
                toolTipText = ""
                addMouseListener(object : MouseAdapter() {
                    override fun mouseClicked(e: MouseEvent) {
                        hit.firstOrNull { e.x >= it.first && e.x < it.second }
                            ?.takeIf { it.third.module != OVERFLOW_MODULE } // the "+K more" tail isn't a filter
                            ?.let { onClick?.invoke(it.third.module) }
                    }
                })
            }

            fun update(modules: List<ChangeMapModule>, selected: String?) {
                // Cap the strip (VS Code parity): a busy session can span dozens of modules, which
                // squeezes every segment into unreadable slivers — keep the top movers (modules arrive
                // churn-ranked from core), merge the tail into one gray non-clickable "+K more" segment.
                mods = if (modules.size > MAX_SEGMENTS) {
                    val tail = modules.drop(MAX_SEGMENTS)
                    modules.take(MAX_SEGMENTS) + ChangeMapModule(
                        module = OVERFLOW_MODULE, label = "+${tail.size} more",
                        churn = tail.sumOf { it.churn }, cnt = tail.sumOf { it.cnt },
                        kept = tail.sumOf { it.kept }, pending = tail.sumOf { it.pending },
                        undone = tail.sumOf { it.undone }, status = "undone", // → the gray status color
                        files = tail.sumOf { it.files }, chapters = emptyList(),
                    )
                } else modules
                sel = selected
                repaint()
            }

            override fun getToolTipText(e: MouseEvent): String? =
                hit.firstOrNull { e.x >= it.first && e.x < it.second }?.third?.let { m ->
                    "${m.label} · ${m.churn} lines · ${m.files} file(s)"
                }

            override fun paintComponent(g: Graphics) {
                val g2 = g as Graphics2D
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                if (mods.isEmpty()) return
                val h = height
                val n = mods.size
                g2.font = JBUI.Fonts.miniFont()
                val acc = mutableListOf<Triple<Int, Int, ChangeMapModule>>()
                for ((i, m) in mods.withIndex()) {
                    val x0 = i * width / n
                    val x1 = (i + 1) * width / n
                    val w = x1 - x0
                    val isSel = sel == m.module
                    val base = statusColor(m.status)
                    g2.color = if (sel != null && !isSel) UIUtil.toAlpha(base, 90) else base
                    g2.fillRect(x0, 0, w, h)
                    if (i > 0) {
                        g2.color = UIUtil.getPanelBackground()
                        g2.fillRect(x0, 0, JBUI.scale(1), h)
                    }
                    val lbl = clipStr(g2, m.label, w - JBUI.scale(4))
                    if (lbl.isNotEmpty()) {
                        g2.color = JBColor(Color(0x22, 0x22, 0x22), Color(0x1a, 0x1a, 0x1a))
                        val tw = g2.fontMetrics.stringWidth(lbl)
                        g2.drawString(lbl, x0 + (w - tw) / 2, h / 2 + g2.fontMetrics.ascent / 2 - JBUI.scale(1))
                    }
                    if (isSel) {
                        g2.color = UIUtil.getLabelForeground()
                        g2.drawRect(x0, 0, w - 1, h - 1)
                    }
                    acc.add(Triple(x0, x1, m))
                }
                hit = acc
            }

            private fun clipStr(g2: Graphics2D, s: String, w: Int): String {
                if (w <= 0) return ""
                if (g2.fontMetrics.stringWidth(s) <= w) return s
                var t = s
                while (t.length > 1 && g2.fontMetrics.stringWidth("$t…") > w) t = t.dropLast(1)
                return if (g2.fontMetrics.stringWidth("$t…") > w) "" else "$t…"
            }
        }

        /** One ledger row: status dot · file · module · churn bar · ±lines · pending count. */
        private inner class LedgerRenderer : JComponent(), ListCellRenderer<ChangeMapFile> {
            private var value: ChangeMapFile? = null
            private var selected = false
            private var max = 1

            init {
                preferredSize = Dimension(JBUI.scale(200), JBUI.scale(18))
            }

            fun configure(max: Int) {
                this.max = max
            }

            override fun getListCellRendererComponent(
                list: JList<out ChangeMapFile>, v: ChangeMapFile, index: Int, isSelected: Boolean, cellHasFocus: Boolean,
            ): Component {
                value = v
                selected = isSelected
                toolTipText = buildString {
                    append(v.rel)
                    append("\n+${v.churn} · ${v.cnt} unit(s) · ${v.kept}✓ ${v.pending}⧗ ${v.undone}↩")
                    if (v.classes.isNotEmpty()) append("\n" + v.classes.take(4).joinToString(", "))
                    v.reason?.let { append("\n“$it”") }
                    v.risk?.let { append("\n⚠ $it") }
                    append("\nDouble-click → open the diff")
                }
                return this
            }

            override fun paintComponent(g: Graphics) {
                val v = value ?: return
                val g2 = g as Graphics2D
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                if (selected) {
                    g2.color = UIUtil.getListSelectionBackground(true)
                    g2.fillRect(0, 0, width, height)
                }
                val fg = if (selected) UIUtil.getListSelectionForeground(true) else UIUtil.getLabelForeground()
                val grey = if (selected) UIUtil.getListSelectionForeground(true) else UIUtil.getContextHelpForeground()
                val col = statusColor(v.status)
                val mid = height / 2

                var x = JBUI.scale(3)
                g2.color = col
                g2.fillRoundRect(x, mid - JBUI.scale(3), JBUI.scale(6), JBUI.scale(6), 2, 2)
                x += JBUI.scale(11)

                g2.font = JBUI.Fonts.smallFont() // the file name reads at small; the metric columns stay mini
                g2.color = fg
                val nameW = JBUI.scale(120)
                g2.drawString(clip(g2, v.file + (if (v.agent) " ●" else "") + (if (v.risk != null) " ⌐" else ""), nameW), x, mid + JBUI.scale(3))
                x += nameW + JBUI.scale(4)

                g2.font = JBUI.Fonts.miniFont()
                g2.color = grey
                val modW = JBUI.scale(60)
                g2.drawString(clip(g2, v.moduleLabel, modW), x, mid + JBUI.scale(3))
                x += modW + JBUI.scale(6)

                val numW = JBUI.scale(46)
                val pendW = JBUI.scale(28)
                val barW = (width - x - numW - pendW - JBUI.scale(8)).coerceAtLeast(JBUI.scale(16))
                g2.color = JBColor.border()
                g2.fillRoundRect(x, mid - JBUI.scale(2), barW, JBUI.scale(4), 3, 3)
                val fill = (barW.toDouble() * maxOf(1, v.churn) / max).toInt().coerceAtLeast(2)
                g2.color = col
                g2.fillRoundRect(x, mid - JBUI.scale(2), fill, JBUI.scale(4), 3, 3)
                x += barW + JBUI.scale(6)

                g2.color = grey
                val num = "+${v.churn}"
                g2.drawString(num, x + numW - g2.fontMetrics.stringWidth(num), mid + JBUI.scale(3))
                x += numW + JBUI.scale(4)

                val pend = if (v.pending > 0) "${v.pending}⧗" else "✓"
                g2.color = if (v.pending > 0) CM_PENDING else CM_KEPT
                g2.drawString(pend, x + pendW - g2.fontMetrics.stringWidth(pend), mid + JBUI.scale(3))
            }

            private fun clip(g2: Graphics2D, s: String, w: Int): String {
                if (g2.fontMetrics.stringWidth(s) <= w) return s
                var t = s
                while (t.isNotEmpty() && g2.fontMetrics.stringWidth("$t…") > w) t = t.dropLast(1)
                return "$t…"
            }
        }
    }
}

// --- shared render helpers (file-private) ---

/** phase → (glyph, text attributes). `awaiting-permission` is the needs-attention state (§2.8). */
private fun phaseBadge(phase: String): Pair<String, SimpleTextAttributes> = when (phase) {
    "working" -> "▶ working" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_WORKING)
    "awaiting-input" -> "❓ awaiting input" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_ATTENTION)
    "awaiting-permission" -> "⏸ awaiting permission" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_ATTENTION)
    "errored" -> "✖ errored" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_ERROR)
    "done" -> "● done" to SimpleTextAttributes(SimpleTextAttributes.STYLE_BOLD, MT_DONE)
    else -> "○ idle" to SimpleTextAttributes.GRAYED_BOLD_ATTRIBUTES
}

/** ~20 activity bins → a PAINTED mini bar chart (one bar per bin, height v/max, bar ≈72% of its slot) —
 *  the same geometry VS Code's spark() SVG draws, replacing the old unicode block-glyph sparkline. */
private class SparklineIcon(private val bins: List<Int>) : Icon {
    private val w = JBUI.scale(58)
    private val h = JBUI.scale(11)
    override fun getIconWidth(): Int = w
    override fun getIconHeight(): Int = h

    override fun paintIcon(c: Component?, g: Graphics, x: Int, y: Int) {
        val max = bins.maxOrNull() ?: 0
        if (max <= 0) return // empty / all-zero bins → nothing to paint
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            g2.color = UIUtil.toAlpha(MT_WORKING, 170) // chart-blue bars — the VS Code --mt-spark color
            val slot = w.toDouble() / bins.size
            val bar = (slot * 0.72).toInt().coerceAtLeast(1)
            for ((i, v) in bins.withIndex()) {
                if (v <= 0) continue
                val bh = ((v.toDouble() / max) * h).toInt().coerceAtLeast(1)
                g2.fillRect(x + (i * slot).toInt(), y + h - bh, bar, bh)
            }
        } finally {
            g2.dispose()
        }
    }
}

private fun fmtTok(n: Long): String = when {
    n >= 1_000_000 -> "%.1fM".format(n / 1_000_000.0)
    n >= 1_000 -> "${n / 1000}k"
    else -> "$n"
}

private fun fmtDur(ms: Long): String {
    val s = ms / 1000
    if (s < 60) return "${s}s"
    val m = s / 60
    if (m < 60) return "${m}m"
    return "%.1fh".format(m / 60.0)
}

private fun baseName(path: String): String = path.trimEnd('/').substringAfterLast('/').ifBlank { path }

private fun shortFile(path: String): String {
    val parts = path.trimEnd('/').split('/')
    return if (parts.size <= 2) path else ".../" + parts.takeLast(2).joinToString("/")
}

private fun clip(s: String, n: Int): String = if (s.length <= n) s else s.take(n - 1) + "…"

private fun clipText(s: String, n: Int): String = if (s.length <= n) s else s.take(n - 1) + "…"

/** Minimal HTML escape for text interpolated into a JBLabel's <html> body (the bottom summary name). */
private fun escHtml(s: String): String =
    s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

/**
 * A two-cluster toolbar row that mirrors CSS `flex-wrap: wrap; justify-content: space-between`
 * (VS Code's `.ov-tbrow.split`): the LEFT cluster (child 0) pins to the left edge and the RIGHT cluster
 * (child 1) pins to the right edge while both fit on one line; when the row is too narrow for both, the
 * right cluster wraps onto a second line (left-aligned) so nothing is clipped. The preferred height
 * tracks the current width — the host row's width-change listener revalidates so the toolbar grows the
 * extra row rather than cutting the right cluster off (as the old fixed GridBagLayout did).
 */
internal class SplitWrapLayout(private val vgap: Int) : LayoutManager2 {
    override fun addLayoutComponent(name: String?, comp: Component?) {}
    override fun addLayoutComponent(comp: Component?, constraints: Any?) {}
    override fun removeLayoutComponent(comp: Component?) {}
    override fun getLayoutAlignmentX(target: Container?): Float = 0f
    override fun getLayoutAlignmentY(target: Container?): Float = 0.5f
    override fun invalidateLayout(target: Container?) {}
    // Width MAX so a BoxLayout Y_AXIS host stretches this row to the full toolbar width (the right
    // cluster must be able to reach the true right edge); the host caps height to preferred.
    override fun maximumLayoutSize(target: Container): Dimension = Dimension(Int.MAX_VALUE, Int.MAX_VALUE)

    private fun kids(parent: Container): List<Component> =
        (0 until parent.componentCount).map { parent.getComponent(it) }.filter { it.isVisible }

    /** True when the two clusters can't sit side by side within [avail] px. */
    private fun wraps(left: Component?, right: Component?, avail: Int): Boolean =
        left != null && right != null && avail > 0 &&
            left.preferredSize.width + right.preferredSize.width > avail

    override fun preferredLayoutSize(parent: Container): Dimension {
        val ins = parent.insets
        val k = kids(parent)
        val left = k.getOrNull(0); val right = k.getOrNull(1)
        val lp = left?.preferredSize ?: Dimension()
        val rp = right?.preferredSize ?: Dimension()
        val avail = parent.width - ins.left - ins.right
        return if (wraps(left, right, avail))
            Dimension(maxOf(lp.width, rp.width) + ins.left + ins.right, lp.height + vgap + rp.height + ins.top + ins.bottom)
        else
            Dimension(lp.width + rp.width + ins.left + ins.right, maxOf(lp.height, rp.height) + ins.top + ins.bottom)
    }

    override fun minimumLayoutSize(parent: Container): Dimension = preferredLayoutSize(parent)

    override fun layoutContainer(parent: Container) {
        val ins = parent.insets
        val k = kids(parent)
        val left = k.getOrNull(0); val right = k.getOrNull(1)
        val lp = left?.preferredSize ?: Dimension()
        val rp = right?.preferredSize ?: Dimension()
        val avail = parent.width - ins.left - ins.right
        if (wraps(left, right, avail)) {
            left?.setBounds(ins.left, ins.top, minOf(lp.width, avail), lp.height)
            right?.setBounds(ins.left, ins.top + lp.height + vgap, minOf(rp.width, avail), rp.height)
        } else {
            left?.setBounds(ins.left, ins.top, lp.width, lp.height)
            right?.setBounds(parent.width - ins.right - rp.width, ins.top, rp.width, rp.height)
        }
    }
}
