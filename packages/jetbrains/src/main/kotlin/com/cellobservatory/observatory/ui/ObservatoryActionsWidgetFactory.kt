package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.inline.InlineOverlay
import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.CustomStatusBarWidget
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.util.messages.MessageBusConnection
import java.io.File
import javax.swing.Icon
import javax.swing.JComponent

private const val CLUSTER_ID = "claudeObservatoryActions"

/** The nav bar: a review toolbar beside the 🔬 scoreboard, visible ONLY while edits await review
 *  (parity with the VS Code status-bar nav bar). Adopted from Void's editor review bar — two tiers:
 *   • session tier   — File axis (◀ n/m ▶), Clear resolved, Spotlight, Search — whenever any edit is pending
 *   • active-file tier — Diff axis (▲ n/m ▼), Keep/Undo this edit, Accept/Reject File — when the OPEN file
 *     has pending edits.
 *  One CustomStatusBarWidget hosting an ActionToolbar; per-action visibility drives the two tiers. */
class ObservatoryActionsWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = CLUSTER_ID
    override fun getDisplayName() = "Claude Observatory: Review Actions"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = ObservatoryActionsWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}

private class ObservatoryActionsWidget(private val project: Project) : CustomStatusBarWidget {

    private val service get() = ObservatoryService.getInstance(project)
    private val listener = Runnable { refreshUi() }
    private var busConn: MessageBusConnection? = null

    // The pending edit the Diff axis is parked on within the open file (mirrors the VS Code navEditId).
    @Volatile private var navEditId: Int? = null

    private val toolbar = ActionManager.getInstance()
        .createActionToolbar("ClaudeObservatoryNavBar", buildGroup(), true)
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
        // The Diff/File counters depend on the active editor, so refresh on tab switches too.
        busConn = project.messageBus.connect().also {
            it.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) = refreshUi()
            })
        }
        refreshUi() // correct from activation, not just after the first store event
    }

    override fun dispose() {
        service.removeListener(listener)
        busConn?.disconnect()
        busConn = null
    }

    /** Show the whole bar only while edits await review, and recompute every button's state; on the EDT. */
    @Suppress("DEPRECATION") // updateActionsImmediately: still the way to force a status-bar toolbar refresh
    private fun refreshUi() {
        ApplicationManager.getApplication().invokeLater {
            if (project.isDisposed) return@invokeLater
            toolbar.component.isVisible = service.counts().pending > 0
            toolbar.updateActionsImmediately()
        }
    }

    private fun buildGroup() = DefaultActionGroup(
        // Diff axis — steps the OPEN file's pending edits; the counter opens the current edit's diff.
        iconAct("Previous edit in this file", AllIcons.Actions.PreviousOccurence, ::activeHasPending) { navDiff(-1) },
        textAct(::diffCounterText) { currentNavRec()?.let { rec -> session()?.let { Diffs.show(project, it, rec) } } },
        iconAct("Next edit in this file", AllIcons.Actions.NextOccurence, ::activeHasPending) { navDiff(1) },
        // File axis — steps across every file with pending edits; the counter opens the Edits tool window.
        iconAct("Previous changed file", AllIcons.Actions.Back, ::sessionHasPending) { navFile(-1) },
        textAct(::fileCounterText) { ToolWindowManager.getInstance(project).getToolWindow("Claude Observatory")?.activate(null) },
        iconAct("Next changed file", AllIcons.Actions.Forward, ::sessionHasPending) { navFile(1) },
        // Per-edit + per-file actions on the OPEN file.
        iconAct("Keep This Edit", AllIcons.Actions.Checked, ::activeHasPending) {
            currentNavRec()?.let { rec -> withSession { s -> ReviewOps.keep(project, s, rec.id) } }
        },
        iconAct("Undo This Edit", AllIcons.Actions.Rollback, ::activeHasPending) {
            currentNavRec()?.let { rec -> withSession { s -> ReviewOps.undoOrRedo(project, s, rec, redo = false) } }
        },
        iconAct("Accept File", Icons.CheckAll, ::activeHasPending) {
            activeFilePath()?.let { f -> withSession { s -> ReviewOps.keepAll(project, s, service.log().filter { it.file == f }, File(f).name) } }
        },
        iconAct("Reject File", AllIcons.Actions.Cancel, ::activeHasPending) {
            activeFilePath()?.let { f -> withSession { s -> ReviewOps.undoAll(project, s, service.log().filter { it.file == f }, File(f).name, f) } }
        },
        // Session-wide utilities.
        iconAct("Clear Resolved Edits", AllIcons.Actions.GC, ::sessionHasPending) {
            withSession { s ->
                val resolved = service.log().count { !it.pending }
                if (resolved > 0) ReviewOps.clearResolved(project, s, resolved) else ReviewOps.notify(project, "No resolved edits to clear")
            }
        },
        iconAct("Toggle Spotlight — dim unedited lines", AllIcons.Actions.IntentionBulb, ::sessionHasPending) {
            InlineOverlay.getInstance(project).toggleHeatmap()
        },
        iconAct("Search Edits", AllIcons.Actions.Find, ::sessionHasPending) { searchEdits() },
    )

    // --- nav-bar state (mirrors the VS Code helpers) ---

    private fun session(): String? = service.currentSession()
    private fun activeFilePath(): String? = FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?.path
    private fun sessionHasPending(): Boolean = service.counts().pending > 0
    private fun pendingFiles(): List<String> = service.log().filter { it.pending }.map { it.file }.distinct().sorted()
    private fun pendingInActiveFile(): List<EditRecord> {
        val f = activeFilePath() ?: return emptyList()
        return service.log().filter { it.pending && it.file == f }.sortedBy { it.id }
    }
    private fun activeHasPending(): Boolean = pendingInActiveFile().isNotEmpty()

    /** The pending edit the Diff axis is parked on, anchoring navEditId to a still-pending edit. */
    private fun currentNavRec(): EditRecord? {
        val list = pendingInActiveFile()
        if (list.isEmpty()) return null
        if (list.none { it.id == navEditId }) navEditId = list.first().id
        return list.find { it.id == navEditId }
    }

    /** Diff-axis counter text ("Diff n/m"), or null when the open file has nothing to review (hides it). */
    private fun diffCounterText(): String? {
        val list = pendingInActiveFile()
        if (list.isEmpty()) return null
        if (list.none { it.id == navEditId }) navEditId = list.first().id
        val idx = list.indexOfFirst { it.id == navEditId }
        return "Diff ${idx + 1}/${list.size}"
    }

    /** File-axis counter text ("File n/m"), or null when nothing is pending (hides it). */
    private fun fileCounterText(): String? {
        val files = pendingFiles()
        if (files.isEmpty()) return null
        val idx = activeFilePath()?.let { files.indexOf(it) } ?: -1
        return "File ${if (idx >= 0) idx + 1 else "–"}/${files.size}"
    }

    private fun navDiff(dir: Int) {
        val list = pendingInActiveFile()
        if (list.isEmpty()) return
        val idx = list.indexOfFirst { it.id == navEditId }.let { if (it < 0) 0 else it }
        val target = list[(idx + dir + list.size) % list.size]
        navEditId = target.id
        session()?.let { Navigate.openFileAtEdit(project, it, target) }
        refreshUi()
    }

    private fun navFile(dir: Int) {
        val files = pendingFiles()
        if (files.isEmpty()) return
        val idx = activeFilePath()?.let { files.indexOf(it) } ?: -1
        val target = files[((if (idx < 0) 0 else idx) + dir + files.size) % files.size]
        val first = service.log().filter { it.pending && it.file == target }.minByOrNull { it.id } ?: return
        navEditId = first.id
        session()?.let { Navigate.openFileAtEdit(project, it, first) }
        refreshUi()
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

    /** An icon toolbar button, shown only when [visible] (drives the two tiers). */
    private fun iconAct(text: String, icon: Icon, visible: () -> Boolean, run: () -> Unit): AnAction =
        object : AnAction(text, text, icon), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT // reads the active editor
            override fun update(e: AnActionEvent) { e.presentation.isVisible = visible() }
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** A text toolbar button (the Diff/File counter); hidden when [dynamicText] returns null. */
    private fun textAct(dynamicText: () -> String?, run: () -> Unit): AnAction =
        object : AnAction(), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT // reads the active editor
            @Suppress("OVERRIDE_DEPRECATION") // displayTextInToolbar: still honored; renders the counter text
            override fun displayTextInToolbar() = true // force the counter text to render in the toolbar
            override fun update(e: AnActionEvent) {
                val t = dynamicText()
                e.presentation.isVisible = t != null
                e.presentation.text = t ?: ""
            }
            override fun actionPerformed(e: AnActionEvent) = run()
        }
}
