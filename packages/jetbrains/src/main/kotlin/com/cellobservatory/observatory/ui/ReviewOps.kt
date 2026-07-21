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
import com.intellij.openapi.wm.WindowManager
import com.intellij.util.concurrency.EdtScheduledExecutorService
import java.util.concurrent.TimeUnit

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
            // Routine single-edit keep → transient status bar (no Event Log pile-up); failures stay balloons.
            if (ObservatoryCli.keep(session, id, project.basePath)) doneQuiet(project, "Kept edit #$id")
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
        // Routine single-edit undo/redo confirmation → transient status bar (no Event Log pile-up);
        // failures stay as balloons. Parity with VS Code's setStatusBarMessage.
        if (res.ok) status(project, res.message) else notify(project, res.message, NotificationType.ERROR)
    }

    /** Undo all PENDING edits in scope, newest-first — with a dirty-buffer guard + confirm. Accepted
     *  edits are left on disk; revert those individually. The revert itself is ONE CLI call backed by
     *  core.undoScope (the single scoped-revert implementation the CLI + VS Code also use), not a per-id
     *  loop — so the three front-ends can't drift. `under` = null reverts the whole session; a path
     *  reverts a file or folder (everything beneath). */
    fun undoAll(project: Project, session: String, targets: List<EditRecord>, scope: String, under: String? = null) {
        val list = targets.filter { it.pending }.sortedByDescending { it.id }
        if (list.isEmpty()) {
            notify(project, "Nothing to revert in $scope.")
            return
        }
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

    /** Re-apply all UNDONE edits in scope, oldest-first — the forward mirror of [undoAll]. Same dirty-buffer
     *  guard + confirm; the redo is ONE CLI call backed by core.redoScope (`redo --all` / `--under`), not a
     *  per-id loop, so the three front-ends can't drift. `under` = null re-applies the whole session. */
    fun redoAll(project: Project, session: String, targets: List<EditRecord>, scope: String, under: String? = null) {
        val list = targets.filter { it.undone }.sortedBy { it.id }
        if (list.isEmpty()) {
            notify(project, "Nothing to redo in $scope.")
            return
        }
        val dirty = list.map { it.file }.distinct().filter { isDirty(it) }
        if (dirty.isNotEmpty()) {
            if (!confirmSaveAll(project, dirty)) return
        }
        val fileCount = list.map { it.file }.distinct().size
        val ok = Messages.showYesNoDialog(
            project,
            "Re-apply ${list.size} undone edit(s) across $fileCount file(s) in $scope?\n\n" +
                "This rewrites the files on disk. Overlapping edits may conflict " +
                "(redo those individually to force).",
            "Redo Claude's Edits",
            "Redo ${list.size} Edit(s)", "Cancel", Messages.getWarningIcon(),
        )
        if (ok != Messages.YES) return
        val files = list.map { it.file }.distinct()
        runBg(project, "Re-applying ${list.size} edit(s)") {
            val res = ObservatoryCli.redoScope(session, under, project.basePath)
            files.forEach { refreshFile(it) }
            under?.let { refreshRecursive(it) }
            if (res == null) {
                done(project, cliFailMsg("redo edits"), NotificationType.ERROR)
            } else {
                done(
                    project,
                    "Re-applied ${res.redone} edit(s)" + if (res.conflicts > 0) " · ${res.conflicts} conflict(s) — redo those individually to force" else "",
                )
            }
        }
    }

    /** Reject (revert) every PENDING edit in ONE module bucket — the Overview Folder-axis Reject. Acts on
     *  the bucket's EXACT edits (by id), never the recursive subtree a path scope would catch — mirrors VS
     *  Code's `undoEditsInFolder` (core.undoScope({ ids })). Same dirty-buffer guard + confirm + refresh as
     *  [undoAll]; the revert is ONE CLI call (`undo --ids`), not a per-id loop. */
    fun undoFolder(project: Project, session: String, targets: List<EditRecord>, folderLabel: String) {
        val list = targets.filter { it.pending }.sortedByDescending { it.id }
        if (list.isEmpty()) {
            notify(project, "No pending edits to reject in $folderLabel")
            return
        }
        val dirty = list.map { it.file }.distinct().filter { isDirty(it) }
        if (dirty.isNotEmpty() && !confirmSaveAll(project, dirty)) return
        val files = list.map { it.file }.distinct()
        val ok = Messages.showYesNoDialog(
            project,
            "Revert ${list.size} pending edit(s) across ${files.size} file(s) in folder “$folderLabel”?\n\n" +
                "This rewrites the files on disk. Later-overlapping edits may conflict " +
                "(revert those individually to force-restore).",
            "Revert Claude's Edits",
            "Revert ${list.size} Edit(s)", "Cancel", Messages.getWarningIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Reverting ${list.size} edit(s) in $folderLabel") {
            val res = ObservatoryCli.undoScopeIds(session, list.map { it.id }, project.basePath)
            files.forEach { refreshFile(it) }
            if (res == null) {
                done(project, cliFailMsg("revert edits in $folderLabel"), NotificationType.ERROR)
            } else {
                done(
                    project,
                    "Reverted ${res.undone} edit(s) in folder “$folderLabel”" +
                        if (res.conflicts > 0) " · ${res.conflicts} conflict(s) — revert those individually to force" else "",
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
                if (md.isNullOrBlank()) notify(project, errorMsg) else openMarkdownTab(project, name, md)
            }
        }
    }

    /** Write [text] to a temp `.md` and open it in an editor tab (shared by Export / Doctor / Analyze). */
    private fun openMarkdownTab(project: Project, name: String, text: String) {
        val tmp = java.io.File.createTempFile(name, ".md")
        tmp.writeText(text)
        LocalFileSystem.getInstance().refreshAndFindFileByPath(tmp.path)?.let { vf ->
            FileEditorManager.getInstance(project).openFile(vf, true)
        }
    }

    /** Run `doctor` and open the setup diagnostics (hooks, PATH, config, session, status line) in a tab. */
    fun openDoctor(project: Project) {
        openMarkdown(project, "claude-observatory-doctor", "Could not run doctor (is the claude-observatory CLI installed?)") {
            ObservatoryCli.doctorMarkdown(project.basePath)
        }
    }

    /** Opt-in `claude -p` deep analysis of one edit — spends tokens, can run for minutes (parity with VS
     *  Code's analyzeEdit). Runs the CLI's `analyze` (honoring the `claudeBin` setting) and opens its
     *  result as a markdown tab. */
    fun analyzeEdit(project: Project, session: String, id: Int) {
        runBg(project, "Analyzing edit #$id with Claude…") {
            val text = ObservatoryCli.analyze(session, id, project.basePath)
            ApplicationManager.getApplication().invokeLater {
                if (text.isNullOrBlank()) {
                    notify(project, "Could not analyze edit #$id — is the claude CLI installed? Set its path in Settings → Tools → Claude Observatory.", NotificationType.ERROR)
                } else {
                    openMarkdownTab(project, "claude-observatory-analysis-$id", text)
                }
            }
        }
    }

    /** Opt-in `claude -p` recap: regenerate the session recap — spends tokens, can run for minutes (parity
     *  with VS Code's refreshRecap). Hands the fresh text back on the EDT so the caller repaints. */
    fun refreshRecap(project: Project, session: String, onRecap: (String) -> Unit) {
        runBg(project, "Refreshing the session recap with Claude…") {
            val text = ObservatoryCli.recap(session, fresh = true, project.basePath)
            ApplicationManager.getApplication().invokeLater {
                if (text.isNullOrBlank()) {
                    notify(project, "Could not refresh the recap — is the claude CLI installed? Set its path in Settings → Tools → Claude Observatory.", NotificationType.ERROR)
                } else {
                    onRecap(text)
                }
            }
        }
    }

    /** Install the PreToolUse/PostToolUse capture hooks (`claude-observatory init`). Shared by the
     *  Observations panel toolbar and the registered Install Hooks action. */
    fun installHooks(project: Project) {
        runBg(project, "Installing capture hooks…") {
            val r = ObservatoryCli.init(project.basePath)
            ApplicationManager.getApplication().invokeLater {
                if (r.ok) {
                    notify(project, "Capture hooks installed. Quit Claude Code and relaunch it — hooks are snapshotted at session start.")
                } else {
                    notify(project, "Install failed — is the claude-observatory CLI installed? ${r.stderr.take(200)}", NotificationType.ERROR)
                }
            }
        }
    }

    /** Store maintenance (parity with the CLI `clean`): GC orphaned blobs, or drop the whole session.
     *  Shared by the Observations panel toolbar and the registered Clean Store action; the chooser popup
     *  centers on [anchor], or in the current window when invoked from Find Action / a keymap. */
    fun cleanStore(project: Project, anchor: javax.swing.JComponent? = null) {
        val session = ObservatoryService.getInstance(project).currentSession()
            ?: return notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        val gcOpt = "Reclaim disk — garbage-collect orphaned blobs"
        val dropOpt = "Drop this session — delete its edits + blobs (files on disk are unchanged)"
        val popup = com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createPopupChooserBuilder(listOf(gcOpt, dropOpt))
            .setTitle("Clean the store")
            .setItemChosenCallback { chosen ->
                val drop = chosen == dropOpt
                if (drop) {
                    val ok = Messages.showYesNoDialog(
                        project, "Drop session $session? This deletes its captured edits + blobs. Files on disk are NOT changed.",
                        "Claude Observatory", "Drop Session", "Cancel", Messages.getWarningIcon(),
                    )
                    if (ok != Messages.YES) return@setItemChosenCallback
                }
                runBg(project, "Cleaning store…") {
                    val r = if (drop) ObservatoryCli.dropSession(session, project.basePath) else ObservatoryCli.gc(session, project.basePath)
                    ApplicationManager.getApplication().invokeLater {
                        if (r.ok) {
                            ObservatoryService.getInstance(project).refresh()
                            notify(project, if (drop) "Dropped session $session." else "Reclaimed disk (GC complete).")
                        } else {
                            notify(project, "Clean failed — ${r.stderr.take(160)}", NotificationType.ERROR)
                        }
                    }
                }
            }
            .createPopup()
        if (anchor != null) popup.showInCenterOf(anchor) else popup.showCenteredInCurrentWindow(project)
    }

    /** Switch Session with no explicit anchor (Find Action / keymap) — centers the chooser in the window. */
    fun chooseSession(project: Project) = chooseSessionPopup(project).showCenteredInCurrentWindow(project)

    /** Pin which capture session the observatory shows (e.g. the demo-showcase fixture) instead of the
     *  auto-resolved newest one — a chooser over every session in the store, centered on [anchor]. */
    fun chooseSession(project: Project, anchor: javax.swing.JComponent) = chooseSessionPopup(project).showInCenterOf(anchor)

    private fun chooseSessionPopup(project: Project): com.intellij.openapi.ui.popup.JBPopup {
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
        return com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labelToId.keys.toList())
            .setTitle("Review which session?")
            .setItemChosenCallback { chosen ->
                settings.state.session = labelToId[chosen]
                for (p in com.intellij.openapi.project.ProjectManager.getInstance().openProjects) {
                    ObservatoryService.getInstance(p).refresh()
                }
            }
            .createPopup()
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

    /** A transient status-bar message (bottom-left) that auto-clears — for routine confirmations that
     *  should NOT pile up in the Event Log. Parity with VS Code's setStatusBarMessage; balloons stay
     *  reserved for errors/conflicts. Call on the EDT. */
    fun status(project: Project, text: String) {
        val bar = WindowManager.getInstance().getStatusBar(project) ?: return
        bar.info = text
        EdtScheduledExecutorService.getInstance().schedule(
            Runnable { if (!project.isDisposed && bar.info == text) bar.info = "" },
            4, TimeUnit.SECONDS,
        )
    }

    /** Like [done] but routes the confirmation through the transient status bar instead of a balloon. */
    private fun doneQuiet(project: Project, msg: String) {
        ApplicationManager.getApplication().invokeLater {
            ObservatoryService.getInstance(project).refresh()
            status(project, msg)
        }
    }
}
