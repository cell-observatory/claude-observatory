package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.UndoResult
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil

/**
 * The keep/undo/redo flows shared by tree actions, editor actions, and (later) inline lenses.
 * Undo/redo write to DISK via the CLI, so: save dirty documents first (with consent), run on a
 * background thread, branch structured conflicts into a Force dialog, refresh VFS + views after.
 */
object ReviewOps {

    fun notify(project: Project, text: String, type: NotificationType = NotificationType.INFORMATION) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("Claude Observatory")
            .createNotification(text, type)
            .notify(project)
    }

    fun keep(project: Project, session: String, id: Int) {
        runBg(project, "Keeping edit #$id") {
            ObservatoryCli.keep(session, id, project.basePath)
            done(project, "Kept edit #$id")
        }
    }

    fun keepAll(project: Project, session: String) {
        runBg(project, "Keeping all pending edits") {
            val n = ObservatoryCli.keepAll(session, project.basePath)
            done(project, "Kept $n edit(s)")
        }
    }

    /** Undo (or redo) one edit. IJ-idiomatic dirty handling: offer Save & Continue, never clobber. */
    fun undoOrRedo(project: Project, session: String, rec: EditRecord, redo: Boolean) {
        val verb = if (redo) "Redo" else "Undo"
        if (!ensureSaved(project, rec.file, verb)) return
        runBg(project, "$verb edit #${rec.id}") {
            val res = if (redo) ObservatoryCli.redo(session, rec.id, force = false, project.basePath)
            else ObservatoryCli.undo(session, rec.id, force = false, project.basePath)
            ApplicationManager.getApplication().invokeLater {
                afterUndo(project, session, rec, res, redo)
            }
        }
    }

    private fun afterUndo(project: Project, session: String, rec: EditRecord, res: UndoResult, redo: Boolean) {
        if (res.conflict) {
            val force = Messages.showYesNoDialog(
                project,
                "${res.message}\n\nForce-${if (redo) "re-apply" else "restore"} the file? " +
                    "This also drops later edits to this file.",
                "Claude Observatory — Conflict",
                if (redo) "Force Re-Apply" else "Force-Restore File",
                "Cancel",
                Messages.getWarningIcon(),
            )
            if (force == Messages.YES) {
                runBg(project, "Force ${if (redo) "re-apply" else "restore"} #${rec.id}") {
                    val forced = if (redo) ObservatoryCli.redo(session, rec.id, force = true, project.basePath)
                    else ObservatoryCli.undo(session, rec.id, force = true, project.basePath)
                    refreshFile(rec.file)
                    done(project, forced.message, if (forced.ok) NotificationType.INFORMATION else NotificationType.ERROR)
                }
            }
            return
        }
        refreshFile(rec.file)
        ObservatoryService.getInstance(project).refresh()
        notify(project, res.message, if (res.ok) NotificationType.INFORMATION else NotificationType.ERROR)
    }

    /** Undo all non-undone edits, newest-first (minimizes surgical conflicts) — with confirm. */
    fun undoAll(project: Project, session: String, targets: List<EditRecord>, scope: String) {
        val list = targets.filter { !it.undone }.sortedByDescending { it.id }
        if (list.isEmpty()) return
        val dirty = list.map { it.file }.distinct().filter { isDirty(it) }
        if (dirty.isNotEmpty()) {
            if (!confirmSaveAll(project, dirty)) return
        }
        val ok = Messages.showYesNoDialog(
            project,
            "Undo ${list.size} edit(s) in $scope? Later-overlapping edits may conflict (undo those individually to force-restore).",
            "Claude Observatory",
            "Undo All", "Cancel", Messages.getQuestionIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Reverting ${list.size} edit(s)") {
            var undone = 0
            var conflicts = 0
            for (r in list) {
                val res = ObservatoryCli.undo(session, r.id, force = false, project.basePath)
                if (res.ok) undone++ else if (res.conflict) conflicts++
            }
            list.map { it.file }.distinct().forEach { refreshFile(it) }
            done(
                project,
                "Reverted $undone edit(s)" + if (conflicts > 0) " · $conflicts conflict(s) — undo those individually to force" else "",
            )
        }
    }

    fun clearResolved(project: Project, session: String, resolvedCount: Int) {
        val ok = Messages.showYesNoDialog(
            project, "Clear $resolvedCount resolved edit(s) from the log? Pending edits are kept.",
            "Claude Observatory", "Clear", "Cancel", Messages.getQuestionIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Clearing resolved edits") {
            ObservatoryCli.clearResolved(session, project.basePath)
            done(project, "Cleared $resolvedCount resolved edit(s)")
        }
    }

    // --- shared plumbing ---

    private fun isDirty(file: String): Boolean {
        val vf = LocalFileSystem.getInstance().findFileByPath(file) ?: return false
        val doc = FileDocumentManager.getInstance().getCachedDocument(vf) ?: return false
        return FileDocumentManager.getInstance().isDocumentUnsaved(doc)
    }

    /** True to proceed. If [file] has unsaved changes, offers Save & Continue (undo writes to disk). */
    private fun ensureSaved(project: Project, file: String, verb: String): Boolean {
        if (!isDirty(file)) return true
        val choice = Messages.showYesNoDialog(
            project,
            "${java.io.File(file).name} has unsaved changes — Claude Observatory ${verb.lowercase()}s by writing to disk.\nSave and continue?",
            "Claude Observatory", "Save && Continue", "Cancel", Messages.getWarningIcon(),
        )
        if (choice != Messages.YES) return false
        FileDocumentManager.getInstance().saveAllDocuments()
        return true
    }

    private fun confirmSaveAll(project: Project, dirtyFiles: List<String>): Boolean {
        val names = dirtyFiles.joinToString("\n") { "• ${java.io.File(it).name}" }
        val choice = Messages.showYesNoDialog(
            project, "These files have unsaved changes:\n$names\nSave all and continue?",
            "Claude Observatory", "Save && Continue", "Cancel", Messages.getWarningIcon(),
        )
        if (choice != Messages.YES) return false
        FileDocumentManager.getInstance().saveAllDocuments()
        return true
    }

    /** The CLI rewrote the file on disk — pull the change into VFS/editors. */
    fun refreshFile(file: String) {
        ApplicationManager.getApplication().invokeLater {
            LocalFileSystem.getInstance().refreshAndFindFileByPath(file)?.let {
                VfsUtil.markDirtyAndRefresh(true, false, false, it)
            }
        }
    }

    private fun runBg(project: Project, title: String, work: () -> Unit) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, false) {
            override fun run(indicator: ProgressIndicator) = work()
        })
    }

    private fun done(project: Project, msg: String, type: NotificationType = NotificationType.INFORMATION) {
        ApplicationManager.getApplication().invokeLater {
            ObservatoryService.getInstance(project).refresh()
            notify(project, msg, type)
        }
    }
}
