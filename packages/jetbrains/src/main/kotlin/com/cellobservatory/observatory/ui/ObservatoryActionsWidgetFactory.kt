package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import javax.swing.Icon
import javax.swing.JComponent

private const val CLUSTER_ID = "claudeObservatoryActions"

/** Compact review-action cluster beside the 🔬 scoreboard — review-next · accept-all · revert-all ·
 *  search — visible ONLY while edits await review (parity with the VS Code status-bar cluster).
 *  One CustomStatusBarWidget hosting an ActionToolbar; the whole toolbar collapses when caught up. */
class ObservatoryActionsWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = CLUSTER_ID
    override fun getDisplayName() = "Claude Observatory: Review Actions"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = ObservatoryActionsWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

private class ObservatoryActionsWidget(private val project: Project) : CustomStatusBarWidget {

    private val service get() = ObservatoryService.getInstance(project)
    private val listener = Runnable { updateVisibility() }

    private val toolbar = ActionManager.getInstance()
        .createActionToolbar("ClaudeObservatoryStatusCluster", buildGroup(), true)
        .apply {
            isReservePlaceAutoPopupIcon = false
            targetComponent = component
            component.isOpaque = false
        }

    override fun ID() = CLUSTER_ID
    override fun getComponent(): JComponent = toolbar.component
    override fun getPresentation(): StatusBarWidget.WidgetPresentation? = null // custom-component widget

    override fun install(statusBar: StatusBar) {
        service.addListener(listener)
        updateVisibility() // correct from activation, not just after the first store event
    }

    override fun dispose() {
        service.removeListener(listener)
    }

    /** Show the cluster only while edits await review; Swing mutation on the EDT. */
    private fun updateVisibility() {
        val show = service.counts().pending > 0
        ApplicationManager.getApplication().invokeLater {
            toolbar.component.isVisible = show
        }
    }

    private fun buildGroup() = DefaultActionGroup(
        act("Review Previous Pending Edit", AllIcons.Actions.Back) { reviewPrev() },
        act("Review Next Pending Edit", AllIcons.Actions.Forward) { reviewNext() },
        act("Accept All Edits", Icons.CheckAll) { withSession { s -> ReviewOps.keepAll(project, s) } },
        act("Revert All Edits", AllIcons.Actions.Rollback) {
            withSession { s -> ReviewOps.undoAll(project, s, service.log(), "this session") }
        },
        act("Search Edits", AllIcons.Actions.Find) { searchEdits() },
    )

    // --- the exact calls EditsTreePanel already uses ---

    private fun reviewNext() = withSession { s ->
        val next = service.nextPendingEdit()
        if (next == null) ReviewOps.notify(project, "No pending Claude edits — all caught up")
        else Navigate.openFileAtEdit(project, s, next)
    }

    private fun reviewPrev() = withSession { s ->
        val prev = service.prevPendingEdit()
        if (prev == null) ReviewOps.notify(project, "No pending Claude edits — all caught up")
        else Navigate.openFileAtEdit(project, s, prev)
    }

    private fun searchEdits() {
        val q = Messages.showInputDialog(
            project, "Filter edits by file path (empty to clear):", "Search Edits",
            null, service.filterQuery, null,
        )
        if (q != null) service.setFilter(q)
    }

    private fun withSession(block: (String) -> Unit) {
        val s = service.currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        block(s)
    }

    private fun act(text: String, icon: Icon, run: () -> Unit): AnAction =
        object : AnAction(text, text, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }
}
