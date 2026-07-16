package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ChatRef
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.UndoResult
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditorManager
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

    /** Shared failure message when a keep/clean CLI call returns non-ok (usually a missing binary). */
    private fun cliFailMsg(action: String) =
        "Could not $action — the claude-observatory CLI failed or isn't installed. " +
            "Install it and set its path in Settings → Tools → Claude Observatory."

    fun keep(project: Project, session: String, id: Int) {
        runBg(project, "Keeping edit #$id") {
            if (ObservatoryCli.keep(session, id, project.basePath)) done(project, "Kept edit #$id")
            else done(project, cliFailMsg("keep edit #$id"), NotificationType.ERROR)
        }
    }

    fun keepAll(project: Project, session: String) {
        runBg(project, "Keeping all pending edits") {
            val n = ObservatoryCli.keepAll(session, project.basePath)
            if (n != null) done(project, "Kept $n edit(s)")
            else done(project, cliFailMsg("keep all edits"), NotificationType.ERROR)
        }
    }

    /** Keep every pending edit in a subset (e.g. one file) — file-scoped accept. */
    fun keepAll(project: Project, session: String, targets: List<EditRecord>, scope: String) {
        val pending = targets.filter { it.pending }
        if (pending.isEmpty()) {
            notify(project, "No pending edits to accept in $scope")
            return
        }
        runBg(project, "Accepting ${pending.size} edit(s) in $scope") {
            val okCount = pending.count { ObservatoryCli.keep(session, it.id, project.basePath) }
            if (okCount == pending.size) {
                done(project, "Accepted ${pending.size} edit(s) in $scope")
            } else {
                done(
                    project,
                    "Accepted $okCount of ${pending.size} edit(s) in $scope — ${pending.size - okCount} failed (is the CLI installed?)",
                    if (okCount > 0) NotificationType.WARNING else NotificationType.ERROR,
                )
            }
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

    /** Undo all PENDING edits in scope, newest-first — with a dirty-buffer guard + confirm. Accepted
     *  edits are left on disk; revert those individually. The revert itself is ONE CLI call backed by
     *  core.undoScope (the single scoped-revert implementation the CLI + VS Code also use), not a per-id
     *  loop — so the three front-ends can't drift. `under` = null reverts the whole session; a path
     *  reverts a file or folder (everything beneath). */
    fun undoAll(project: Project, session: String, targets: List<EditRecord>, scope: String, under: String? = null) {
        val list = targets.filter { it.pending }.sortedByDescending { it.id }
        if (list.isEmpty()) return
        val dirty = list.map { it.file }.distinct().filter { isDirty(it) }
        if (dirty.isNotEmpty()) {
            if (!confirmSaveAll(project, dirty)) return
        }
        // A WARNING, not a question — this rewrites files on disk, and the count can be large.
        val fileCount = list.map { it.file }.distinct().size
        val ok = Messages.showYesNoDialog(
            project,
            "Revert ${list.size} pending edit(s) across $fileCount file(s) in $scope?\n\n" +
                "This rewrites the files on disk. Later-overlapping edits may conflict " +
                "(revert those individually to force-restore).",
            "Revert Claude's Edits",
            "Revert ${list.size} Edit(s)", "Cancel", Messages.getWarningIcon(),
        )
        if (ok != Messages.YES) return
        val files = list.map { it.file }.distinct()
        runBg(project, "Reverting ${list.size} edit(s)") {
            val res = ObservatoryCli.undoScope(session, under, project.basePath)
            files.forEach { refreshFile(it) }
            under?.let { refreshRecursive(it) } // covers any file under a folder scope not in `list`
            if (res == null) {
                done(project, cliFailMsg("revert edits"), NotificationType.ERROR)
            } else {
                done(
                    project,
                    "Reverted ${res.undone} edit(s)" + if (res.conflicts > 0) " · ${res.conflicts} conflict(s) — undo those individually to force" else "",
                )
            }
        }
    }

    fun clearResolved(project: Project, session: String, resolvedCount: Int) {
        val ok = Messages.showYesNoDialog(
            project, "Clear $resolvedCount resolved edit(s) from the log? Pending edits are kept.",
            "Claude Observatory", "Clear", "Cancel", Messages.getQuestionIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Clearing resolved edits") {
            if (ObservatoryCli.clearResolved(session, project.basePath)) done(project, "Cleared $resolvedCount resolved edit(s)")
            else done(project, cliFailMsg("clear resolved edits"), NotificationType.ERROR)
        }
    }

    /** Clear resolved (kept/undone) edits scoped to a file or folder path (the folder/file Clear action). */
    fun clearResolvedScoped(project: Project, session: String, resolvedCount: Int, scope: String, under: String) {
        if (resolvedCount == 0) {
            notify(project, "No resolved edits to clear in $scope")
            return
        }
        val ok = Messages.showYesNoDialog(
            project, "Clear $resolvedCount resolved edit(s) in $scope? Pending edits are kept.",
            "Claude Observatory", "Clear", "Cancel", Messages.getQuestionIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Clearing resolved edits in $scope") {
            if (ObservatoryCli.clearResolved(session, project.basePath, under)) done(project, "Cleared $resolvedCount resolved edit(s) in $scope")
            else done(project, cliFailMsg("clear resolved edits"), NotificationType.ERROR)
        }
    }

    // --- chapter (task) review, over the strict-span task edit sets (0.8.0 Overview ribbon) ---

    /** Accept a chapter: keep every PENDING edit in the task's STRICT-span set (`task-keep`). Non-destructive. */
    fun keepTask(project: Project, session: String, taskId: String, label: String) {
        runBg(project, "Accepting chapter “$label”") {
            val kept = ObservatoryCli.taskKeep(session, taskId, project.basePath)
            when {
                kept == null -> done(project, cliFailMsg("accept chapter “$label”"), NotificationType.ERROR)
                kept == 0 -> done(project, "No pending edits to accept in chapter “$label”")
                else -> done(project, "Accepted $kept edit(s) in chapter “$label”")
            }
        }
    }

    /** Reject a chapter: revert every PENDING edit in the task's STRICT-span set (`task-undo`). Writes to
     *  disk, so save dirty buffers first (with consent) and refresh the workspace subtree after. */
    fun undoTask(project: Project, session: String, taskId: String, label: String) {
        val ok = Messages.showYesNoDialog(
            project,
            "Reject all pending edits in chapter “$label”? This reverts them on disk. " +
                "Unsaved changes to affected files are saved first; later-overlapping edits may conflict " +
                "(revert those individually to force).",
            "Claude Observatory", "Reject Chapter", "Cancel", Messages.getWarningIcon(),
        )
        if (ok != Messages.YES) return
        FileDocumentManager.getInstance().saveAllDocuments()
        runBg(project, "Rejecting chapter “$label”") {
            val res = ObservatoryCli.taskUndo(session, taskId, project.basePath)
            project.basePath?.let { refreshRecursive(it) } // covers every reverted file in the chapter
            if (res == null) {
                done(project, cliFailMsg("reject chapter “$label”"), NotificationType.ERROR)
            } else if (res.undone == 0 && res.conflicts == 0) {
                done(project, "No pending edits to reject in chapter “$label”")
            } else {
                done(
                    project,
                    "Rejected ${res.undone} edit(s) in chapter “$label”" +
                        if (res.conflicts > 0) " · ${res.conflicts} conflict(s) — revert those individually to force" else "",
                )
            }
        }
    }

    /** Clear a chapter: drop the RESOLVED (kept/undone) edits of the task's STRICT-span set (`task-clear`).
     *  Pending edits are preserved. */
    fun clearTask(project: Project, session: String, taskId: String, label: String) {
        runBg(project, "Clearing resolved edits in chapter “$label”") {
            val cleared = ObservatoryCli.taskClear(session, taskId, project.basePath)
            when {
                cleared == null -> done(project, cliFailMsg("clear chapter “$label”"), NotificationType.ERROR)
                cleared == 0 -> done(project, "No resolved edits to clear in chapter “$label”")
                else -> done(project, "Cleared $cleared resolved edit(s) in chapter “$label”")
            }
        }
    }

    /** Clear the resolved edits of EVERY settled chapter (`task-clear --completed`). */
    fun clearCompletedChapters(project: Project, session: String) {
        runBg(project, "Clearing completed chapters") {
            val res = ObservatoryCli.taskClearCompleted(session, project.basePath)
            when {
                res == null -> done(project, cliFailMsg("clear completed chapters"), NotificationType.ERROR)
                res.cleared == 0 -> done(project, "No resolved edits to clear in completed chapters")
                else -> done(project, "Cleared ${res.cleared} resolved edit(s) across ${res.chapters} completed chapter(s)")
            }
        }
    }

    /** Chat about an edit — routes through the single core assembler (chatContext / `chat-context --json`)
     *  so every edit-chat surface gets the same reasoning + task/subagent framing as the Actions and
     *  Multitasking surfaces, instead of a local before/after-only builder. Clipboard-only, zero-token. */
    fun chatAbout(project: Project, session: String, id: Int) {
        chatContext(project, session, ChatRef.Edit(id), "edit #$id")
    }

    /** Zero-token context chat about ANY reference (edit / subagent / task / action / whole session):
     *  core assembles the ready-to-paste prompt via `chat-context --json`, and we copy it to the
     *  clipboard (Anthropic's JetBrains plugin exposes no open-chat API — clipboard-only, degrading
     *  identically to VS Code when the Claude extension is absent). NEVER calls a model. */
    fun chatContext(project: Project, session: String, ref: ChatRef, label: String) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val prompt = ObservatoryCli.chatContextJson(session, project.basePath, ref)
            ApplicationManager.getApplication().invokeLater {
                if (prompt.isNullOrBlank()) {
                    notify(project, cliFailMsg("build the chat context for $label"), NotificationType.ERROR)
                } else {
                    com.intellij.openapi.ide.CopyPasteManager.getInstance()
                        .setContents(java.awt.datatransfer.StringSelection(prompt))
                    notify(project, "Prompt about $label copied — paste it into your Claude Code terminal/chat.")
                }
            }
        }
    }

    /** Fetch markdown off the EDT and open it in an editor tab (or notify on failure). Shared by the
     *  Export Review Summary and Setup Check (doctor) actions across both editors' trees. */
    fun openMarkdown(project: Project, name: String, errorMsg: String, produce: () -> String?) {
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val md = produce()
            app.invokeLater {
                if (md.isNullOrBlank()) {
                    notify(project, errorMsg)
                } else {
                    val tmp = java.io.File.createTempFile(name, ".md")
                    tmp.writeText(md)
                    LocalFileSystem.getInstance().refreshAndFindFileByPath(tmp.path)?.let { vf ->
                        FileEditorManager.getInstance(project).openFile(vf, true)
                    }
                }
            }
        }
    }

    /** Run `doctor` and open the setup diagnostics (hooks, PATH, config, session, status line) in a tab. */
    fun openDoctor(project: Project) {
        openMarkdown(project, "claude-observatory-doctor", "Could not run doctor (is the claude-observatory CLI installed?)") {
            ObservatoryCli.doctorMarkdown(project.basePath)
        }
    }

    /** Pin which capture session the observatory shows (e.g. the demo-showcase fixture) instead of the
     *  auto-resolved newest one — a chooser over every session in the store, centered on [anchor]. */
    fun chooseSession(project: Project, anchor: javax.swing.JComponent) {
        val settings = com.cellobservatory.observatory.settings.ObservatorySettings.instance
        val pinned = settings.state.session?.takeIf { it.isNotBlank() }
        val auto = project.basePath?.let { com.cellobservatory.observatory.core.SessionResolver.resolveSessionId(it) }
        val labelToId = LinkedHashMap<String, String?>()
        labelToId["Auto — newest for this workspace" + (auto?.let { " ($it)" } ?: "")] = null
        for (s in com.cellobservatory.observatory.core.StoreReader.listSessions()) {
            val mark = if (s.id == pinned) "● " else ""
            val autoTag = if (s.id == auto) " · auto" else ""
            labelToId["$mark${s.id}  —  ${s.pending} pending · ${com.cellobservatory.observatory.model.relTime(s.lastMs)}$autoTag"] = s.id
        }
        com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labelToId.keys.toList())
            .setTitle("Review which session?")
            .setItemChosenCallback { chosen ->
                settings.state.session = labelToId[chosen]
                for (p in com.intellij.openapi.project.ProjectManager.getInstance().openProjects) {
                    ObservatoryService.getInstance(p).refresh()
                }
            }
            .createPopup()
            .showInCenterOf(anchor)
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

    /** Recursively re-sync a path from disk (a folder scope's subtree, or a single file). */
    fun refreshRecursive(path: String) {
        ApplicationManager.getApplication().invokeLater {
            LocalFileSystem.getInstance().refreshAndFindFileByPath(path)?.let {
                VfsUtil.markDirtyAndRefresh(true, true, false, it)
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
