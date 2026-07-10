package com.cellobservatory.observatory.ui.editor

import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.Icons
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
        panel.text("$count pending Claude edit(s) in this file")
        panel.createActionLabel("⏮ Prev") {
            val s = service.currentSession() ?: return@createActionLabel
            val prev = service.prevPendingEdit()
            if (prev == null) ReviewOps.notify(project, "No pending Claude edits — all caught up")
            else Navigate.openFileAtEdit(project, s, prev)
        }
        panel.createActionLabel("⏭ Next") {
            val s = service.currentSession() ?: return@createActionLabel
            val next = service.nextPendingEdit()
            if (next == null) ReviewOps.notify(project, "No pending Claude edits — all caught up")
            else Navigate.openFileAtEdit(project, s, next)
        }
        // These act on THIS file only — the banner is per-file, so session-wide would be misleading.
        panel.createActionLabel("✓ Accept file") {
            service.currentSession()?.let { s ->
                ReviewOps.keepAll(project, s, service.log().filter { it.file == file.path }, file.name)
            }
        }
        panel.createActionLabel("✗ Revert file") {
            service.currentSession()?.let { s ->
                ReviewOps.undoAll(project, s, service.log().filter { it.file == file.path }, file.name)
            }
        }
        panel.createActionLabel("🔍 Search") {
            val q = Messages.showInputDialog(
                project, "Filter edits by file path (empty to clear):",
                "Search Edits", null, service.filterQuery, null,
            )
            if (q != null) service.setFilter(q)
        }
        panel.createActionLabel("📄 Heatmap") {
            com.cellobservatory.observatory.ui.inline.InlineOverlay.getInstance(project).toggleHeatmap()
        }
        return panel
    }
}
