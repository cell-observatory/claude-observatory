package com.cellobservatory.observatory.ui.editor

import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.Icons
import com.cellobservatory.observatory.ui.NavTint
import com.cellobservatory.observatory.ui.Navigate
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.EditorNotificationPanel
import com.intellij.ui.EditorNotificationProvider
import java.util.function.Function
import javax.swing.JComponent

/**
 * Persistent review bar atop any editor whose file has pending Claude edits — parity with the VS Code
 * editor-title buttons (⏭ review-next · ✓ accept-all · ↩ revert-all · 🔍 search). Per-file gated; kept
 * live by ObservatoryStartup, which fires EditorNotifications.updateAllNotifications() on every store change.
 */
class ObservatoryEditorBanner : EditorNotificationProvider, DumbAware {

    override fun collectNotificationData(
        project: Project,
        file: VirtualFile,
    ): Function<in FileEditor, out JComponent?>? {
        val service = ObservatoryService.getInstance(project)
        service.currentSession() ?: return null
        // Cheap: cached folded log + path filter, no `locate` subprocess — safe on the provider's BGT.
        val pendingInFile = service.log().count { it.pending && it.file == file.path }
        if (pendingInFile == 0) return null // null ⇒ no banner on files Claude hasn't touched
        return Function { fileEditor -> banner(project, service, file, pendingInFile, fileEditor) }
    }

    // The returned Function is invoked per FileEditor on the EDT — build Swing here, not above.
    private fun banner(
        project: Project,
        service: ObservatoryService,
        file: VirtualFile,
        count: Int,
        fileEditor: FileEditor,
    ): JComponent {
        val panel = EditorNotificationPanel(fileEditor, EditorNotificationPanel.Status.Info)
        panel.icon(Icons.Microscope)
        panel.text("$count pending")
        // Every action carries TEXT: an icon-only createActionLabel("") renders its icon but has no
        // clickable hyperlink region in Swing — the 0.8.x "banner button does nothing" bug.
        // Search leads every nav bar (user rule).
        panel.createActionLabel("Search") {
            val q = Messages.showInputDialog(
                project, "Filter edits by file path (empty to clear):",
                "Search Edits", null, service.filterQuery, null,
            )
            if (q != null) service.setFilter(q)
        }.apply {
            setIcon(NavTint.SEARCH)
            toolTipText = "Search edits"
        }
        panel.createActionLabel("↑") {
            val s = service.currentSession() ?: return@createActionLabel
            val prev = service.prevPendingEdit()
            if (prev == null) ReviewOps.notify(project, "No pending Claude edits — all caught up")
            else Navigate.openFileAtEdit(project, s, prev)
        }.toolTipText = "Previous pending edit"
        panel.createActionLabel("↓") {
            val s = service.currentSession() ?: return@createActionLabel
            val next = service.nextPendingEdit()
            if (next == null) ReviewOps.notify(project, "No pending Claude edits — all caught up")
            else Navigate.openFileAtEdit(project, s, next)
        }.toolTipText = "Next pending edit"
        // File axis — jump across every file with pending edits (parity with the nav bar's ◀ ▶).
        panel.createActionLabel("◀") { stepFile(project, service, file.path, -1) }.toolTipText = "Previous changed file"
        panel.createActionLabel("▶") { stepFile(project, service, file.path, 1) }.toolTipText = "Next changed file"
        // These act on THIS file only — the banner is per-file, so session-wide would be misleading.
        panel.createActionLabel("✓") {
            service.currentSession()?.let { s ->
                ReviewOps.keepAll(project, s, service.log().filter { it.file == file.path }, file.name)
            }
        }.toolTipText = "Accept all edits in this file"
        panel.createActionLabel("↩") {
            service.currentSession()?.let { s ->
                ReviewOps.undoAll(project, s, service.log().filter { it.file == file.path }, file.name, file.path)
            }
        }.toolTipText = "Revert all edits in this file"
        // Clear resolved (kept/reverted) edits — parity with the nav bar's clear button.
        panel.createActionLabel("Clear") {
            service.currentSession()?.let { s ->
                val resolved = service.log().count { !it.pending }
                if (resolved > 0) ReviewOps.clearResolved(project, s, resolved) else ReviewOps.notify(project, "No resolved edits to clear")
            }
        }.apply {
            setIcon(NavTint.CLEAR)
            toolTipText = "Clear resolved (kept/reverted) edits"
        }
        // Spotlight/heatmap toggle — the same lightbulb icon the nav bar uses, so it reads identically
        // across every surface (status-bar nav bar + this editor banner).
        panel.createActionLabel("Spotlight") {
            com.cellobservatory.observatory.ui.inline.InlineOverlay.getInstance(project).toggleHeatmap()
        }.apply {
            setIcon(NavTint.SPOTLIGHT)
            toolTipText = "Toggle file heatmap (spotlight Claude's edits)"
        }
        return panel
    }

    /** Open the first pending edit of the prev (-1) / next (+1) file with pending edits, wrapping. */
    private fun stepFile(project: Project, service: ObservatoryService, current: String, dir: Int) {
        val s = service.currentSession() ?: return
        val files = service.log().filter { it.pending }.map { it.file }.distinct().sorted()
        if (files.isEmpty()) return
        val idx = files.indexOf(current)
        val target = files[((if (idx < 0) 0 else idx) + dir + files.size) % files.size]
        val first = service.log().filter { it.pending && it.file == target }.minByOrNull { it.id } ?: return
        Navigate.openFileAtEdit(project, s, first)
    }
}
