package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.LogicalPosition
import com.intellij.openapi.editor.ScrollType
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.LocalFileSystem

/**
 * Editor navigation anchored by the CLI's `locate` (positional diff mapping into the LIVE buffer —
 * the one read-only algorithm the plan says never to re-port). Locate runs on a background thread;
 * caret moves land back on the EDT.
 */
object Navigate {

    fun openFileAtEdit(project: Project, session: String, rec: EditRecord) {
        val vf = LocalFileSystem.getInstance().refreshAndFindFileByPath(rec.file)
        if (vf == null) {
            ReviewOps.notify(project, "File not found: ${rec.file}", NotificationType.WARNING)
            return
        }
        val editor = FileEditorManager.getInstance(project).openTextEditor(OpenFileDescriptor(project, vf), true) ?: return
        val text = editor.document.text
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Locating edit #${rec.id}", false) {
            override fun run(indicator: ProgressIndicator) {
                val line = ObservatoryCli.locate(session, rec.file, text, project.basePath)
                    .find { it.id == rec.id }?.lines?.firstOrNull() ?: return
                ApplicationManager.getApplication().invokeLater {
                    if (!editor.isDisposed && line < editor.document.lineCount) {
                        editor.caretModel.moveToLogicalPosition(LogicalPosition(line, 0))
                        editor.scrollingModel.scrollToCaret(ScrollType.CENTER)
                    }
                }
            }
        })
    }

    /** Find the pending edit whose current lines contain the caret; result delivered on the EDT. */
    fun pendingAtCursor(project: Project, editor: Editor, onFound: (EditRecord?) -> Unit) {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return onFound(null)
        val file = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(editor.document)?.path
            ?: return onFound(null)
        val caretLine = editor.caretModel.logicalPosition.line
        val text = editor.document.text
        val pending = service.log().filter { it.pending && it.file == file }
        if (pending.isEmpty()) return onFound(null)
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Resolving edit at cursor", false) {
            override fun run(indicator: ProgressIndicator) {
                val hit = ObservatoryCli.locate(session, file, text, project.basePath)
                    .find { caretLine in it.lines }
                val rec = pending.find { it.id == hit?.id }
                ApplicationManager.getApplication().invokeLater { onFound(rec) }
            }
        })
    }
}
