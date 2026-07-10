package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObserveCache
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.diff.tools.fragmented.UnifiedDiffTool
import com.intellij.diff.util.DiffUserDataKeys
import com.intellij.diff.util.DiffUserDataKeysEx
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import java.io.File

/** Before ⟷ after viewer for one edit, from the store's content-addressed blobs. */
object Diffs {

    /** Default to the unified (inline) viewer — the red/green single-column look — unless the user has
     *  opted back to side-by-side. Parity with the VS Code inline-diff toggle. */
    private fun SimpleDiffRequest.preferUnified(): SimpleDiffRequest {
        if (ObservatorySettings.instance.state.unifiedDiff) {
            putUserData(DiffUserDataKeysEx.FORCE_DIFF_TOOL, UnifiedDiffTool.INSTANCE)
        }
        return this
    }

    private fun action(text: String, icon: javax.swing.Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon) {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    fun show(project: Project, session: String, rec: EditRecord) {
        val before = StoreReader.readBlob(session, rec.beforeBlob)
        val after = StoreReader.readBlob(session, rec.afterBlob)
        val name = File(rec.file).name
        val type = FileTypeManager.getInstance().getFileTypeByFileName(name) // syntax highlighting per side
        val factory = DiffContentFactory.getInstance()
        // Claude's reasoning rides in the diff title; Keep/Undo/Chat sit in the diff toolbar.
        val reason = ObserveCache.getInstance(project).payload()?.edits?.find { it.id == rec.id }?.reasoning
            ?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()
        val title = if (reason != null) "#${rec.id} · ${if (reason.length > 80) reason.take(79) + "…" else reason}"
        else "$name — edit #${rec.id}"
        val request = SimpleDiffRequest(
            title,
            factory.create(project, before, type),
            factory.create(project, after, type),
            if (rec.beforeBlob == null) "(new file)" else "before",
            if (rec.afterBlob == null) "(deleted)" else "after",
        )
        request.putUserData(
            DiffUserDataKeys.CONTEXT_ACTIONS,
            listOf(
                action("Keep #${rec.id}", AllIcons.Actions.Checked) { ReviewOps.keep(project, session, rec.id) },
                action("Undo #${rec.id}", AllIcons.Actions.Rollback) { ReviewOps.undoOrRedo(project, session, rec, redo = false) },
                action("Chat About #${rec.id}", AllIcons.General.Balloon) { ReviewOps.chatAbout(project, session, rec.id) },
            ),
        )
        DiffManager.getInstance().showDiff(project, request.preferUnified())
    }

    /** Revision navigation: diff the full-file state EDIT produced (its afterBlob, left) against the live,
     *  editable current file (right). Parity with the VS Code current-vs-revision diff. */
    fun showRevision(project: Project, session: String, rec: EditRecord, currentFile: VirtualFile) {
        val revision = StoreReader.readBlob(session, rec.afterBlob) // "" if the edit deleted the file
        val name = File(rec.file).name
        val type = FileTypeManager.getInstance().getFileTypeByFileName(name)
        val factory = DiffContentFactory.getInstance()
        val request = SimpleDiffRequest(
            "edit #${rec.id} ⟶ (this file)",
            factory.create(project, revision, type), // left: recorded revision (read-only)
            factory.create(project, currentFile),    // right: live, editable current file
            "edit #${rec.id}",
            "(this file)",
        )
        DiffManager.getInstance().showDiff(project, request.preferUnified())
    }
}
