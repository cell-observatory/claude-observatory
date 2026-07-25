package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ChatRef
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.SessionRow
import com.cellobservatory.observatory.model.SessionsParser
import com.cellobservatory.observatory.model.relTime
import com.cellobservatory.observatory.model.UndoResult
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.tour.TourController
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
import java.io.File
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
            // ONE call for the whole set: a per-edit loop spawned a process per edit, which on a long
            // session is thousands of them and reads to the user as a hang.
            val kept = ObservatoryCli.keepIds(session, pending.map { it.id }, project.basePath)
            when {
                kept == null -> done(project, cliFailMsg("accept the edits in $scope"), NotificationType.ERROR)
                kept == 0 -> done(project, "No pending edits to accept in $scope")
                else -> done(project, "Accepted $kept edit(s) in $scope")
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
        ObservatoryService.getInstance(project).refresh(force = true) // the undo/redo just changed the store
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
     *  Code's `undoEditsInFolder` (core.undoScope({ ids })). */
    fun undoFolder(project: Project, session: String, targets: List<EditRecord>, folderLabel: String) {
        undoIds(project, session, targets, folderLabel, "folder “$folderLabel”")
    }

    /** Reject (revert) every PENDING edit in an EXPLICIT id set — the shared implementation behind the
     *  Folder axis and the Prompt axis ("revert everything from this ask"). Same dirty-buffer guard +
     *  confirm + refresh as [undoAll]; the revert is ONE CLI call (`undo --ids`), not a per-id loop, so
     *  the front-ends can't drift. [shortScope] names the set in the terse "nothing to do" notice;
     *  [longScope] names it in the destructive prompt and the result. */
    fun undoIds(project: Project, session: String, targets: List<EditRecord>, shortScope: String, longScope: String) {
        val list = targets.filter { it.pending }.sortedByDescending { it.id }
        if (list.isEmpty()) {
            notify(project, "No pending edits to reject in $shortScope")
            return
        }
        val dirty = list.map { it.file }.distinct().filter { isDirty(it) }
        if (dirty.isNotEmpty() && !confirmSaveAll(project, dirty)) return
        val files = list.map { it.file }.distinct()
        val ok = Messages.showYesNoDialog(
            project,
            "Revert ${list.size} pending edit(s) across ${files.size} file(s) in $longScope?\n\n" +
                "This rewrites the files on disk. Later-overlapping edits may conflict " +
                "(revert those individually to force-restore).",
            "Revert Claude's Edits",
            "Revert ${list.size} Edit(s)", "Cancel", Messages.getWarningIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Reverting ${list.size} edit(s) in $shortScope") {
            val res = ObservatoryCli.undoScopeIds(session, list.map { it.id }, project.basePath)
            files.forEach { refreshFile(it) }
            if (res == null) {
                done(project, cliFailMsg("revert edits in $shortScope"), NotificationType.ERROR)
            } else {
                done(
                    project,
                    "Reverted ${res.undone} edit(s) in $longScope" +
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

    /** Clear the resolved (kept/undone) edits of an explicit id set — the scope a PROMPT names (its
     *  edits span whatever folders the ask happened to touch, so no path expresses it). */
    fun clearResolvedIds(project: Project, session: String, ids: List<Int>, scope: String) {
        val resolved = ObservatoryService.getInstance(project).log().count { it.id in ids && !it.pending }
        if (resolved == 0) {
            notify(project, "No resolved edits to clear in $scope")
            return
        }
        val ok = Messages.showYesNoDialog(
            project, "Clear $resolved resolved edit(s) in $scope? Pending edits are kept.",
            "Claude Observatory", "Clear", "Cancel", Messages.getQuestionIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Clearing resolved edits in $scope") {
            val n = ObservatoryCli.clearResolvedIds(session, ids, project.basePath)
            if (n != null) done(project, "Cleared $n resolved edit(s) in $scope")
            else done(project, cliFailMsg("clear resolved edits"), NotificationType.ERROR)
        }
    }

    // --- Task review, over a to-do's STRICT in-progress span (the Tasks tab's per-row ops).
    // Each op resolves the task's strict edit set in core (taskEditIds): only edits captured while that
    // to-do was actually in progress. An edit that cannot be strictly placed is never swept into a
    // task's destructive scope — the unassigned bucket stays unassigned.

    /** Accept a task: keep every PENDING edit in its strict span (`task-keep`). Non-destructive. */
    fun keepTask(project: Project, session: String, taskId: String, label: String) {
        runBg(project, "Accepting task “$label”") {
            val kept = ObservatoryCli.taskKeep(session, taskId, project.basePath)
            when {
                kept == null -> done(project, cliFailMsg("accept task “$label”"), NotificationType.ERROR)
                kept == 0 -> done(project, "No pending edits to accept in task “$label”")
                else -> done(project, "Accepted $kept edit(s) in task “$label”")
            }
        }
    }

    /** Reject a task: revert every PENDING edit in its strict span (`task-undo`). Writes to disk, so
     *  save dirty buffers first (with consent) and refresh the workspace subtree after. */
    fun undoTask(project: Project, session: String, taskId: String, label: String) {
        val ok = Messages.showYesNoDialog(
            project,
            "Reject all pending edits in task “$label”? This reverts them on disk. " +
                "Unsaved changes to affected files are saved first; later-overlapping edits may conflict " +
                "(revert those individually to force).",
            "Claude Observatory", "Reject Task", "Cancel", Messages.getWarningIcon(),
        )
        if (ok != Messages.YES) return
        FileDocumentManager.getInstance().saveAllDocuments()
        runBg(project, "Rejecting task “$label”") {
            val res = ObservatoryCli.taskUndo(session, taskId, project.basePath)
            project.basePath?.let { refreshRecursive(it) } // covers every reverted file in the task
            if (res == null) {
                done(project, cliFailMsg("reject task “$label”"), NotificationType.ERROR)
            } else if (res.undone == 0 && res.conflicts == 0) {
                done(project, "No pending edits to reject in task “$label”")
            } else {
                done(
                    project,
                    "Rejected ${res.undone} edit(s) in task “$label”" +
                        if (res.conflicts > 0) " · ${res.conflicts} conflict(s) — revert those individually to force" else "",
                )
            }
        }
    }

    /** Clear a task: drop the RESOLVED (kept/undone) edits of its strict span (`task-clear`).
     *  Pending edits are preserved. */
    fun clearTask(project: Project, session: String, taskId: String, label: String) {
        runBg(project, "Clearing resolved edits in task “$label”") {
            val cleared = ObservatoryCli.taskClear(session, taskId, project.basePath)
            when {
                cleared == null -> done(project, cliFailMsg("clear task “$label”"), NotificationType.ERROR)
                cleared == 0 -> done(project, "No resolved edits to clear in task “$label”")
                else -> done(project, "Cleared $cleared resolved edit(s) in task “$label”")
            }
        }
    }

    /** Clear the resolved edits of EVERY settled task (`task-clear --completed`). */
    fun clearCompletedTasks(project: Project, session: String) {
        runBg(project, "Clearing completed tasks") {
            val res = ObservatoryCli.taskClearCompleted(session, project.basePath)
            when {
                res == null -> done(project, cliFailMsg("clear completed tasks"), NotificationType.ERROR)
                res.cleared == 0 -> done(project, "No resolved edits to clear in completed tasks")
                else -> done(project, "Cleared ${res.cleared} resolved edit(s) across ${res.tasks} completed task(s)")
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
                            ObservatoryService.getInstance(project).refresh(force = true) // the store just changed
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
    fun chooseSession(project: Project) {
        chooseSession(project, null)
    }

    /** Pin which capture session the observatory shows (e.g. the demo-showcase fixture) instead of the
     *  auto-resolved newest one — a chooser over every session in the store, centered on [anchor].
     *  Sessions lead with their human-readable TITLE (from `sessions --json`, the single CLI backend),
     *  fetched off the EDT; when the CLI is unavailable the popup still opens with raw ids. */
    fun chooseSession(project: Project, anchor: javax.swing.JComponent?) {
        com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService().submit {
            val entries = sessionEntries(project)
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                val popup = chooseSessionPopup(project, entries)
                if (anchor != null && anchor.isShowing) popup.showInCenterOf(anchor)
                else popup.showCenteredInCurrentWindow(project)
            }
        }
    }

    /** `sessions --json` rows (0.8.8): id + title + conversation recency + which session is live. The
     *  listing is stat-only in core — no store log is parsed, so the popup opens without the multi-second
     *  stall the old pending-count listing paid. Falls back to the in-process store list (ids only) when
     *  the CLI is missing: the chooser must never fail to open. */
    private fun sessionEntries(project: Project): List<SessionRow> {
        val parsed = ObservatoryCli.sessionsJson(project.basePath, ObservatoryService.getInstance(project).currentSession())
            ?.let { SessionsParser.parse(it) }
        if (parsed != null) return parsed.sessions
        // CLI-less fallback: the in-process store reader knows the counts but no titles, so rows carry
        // what it has and nothing invented.
        return com.cellobservatory.observatory.core.StoreReader.listSessions()
            .map { SessionRow(it.id, null, it.lastMs, false, edits = it.edits, pending = it.pending, files = 0) }
    }

    /** The chooser. Rows lead with Claude's own title and are ordered live-session-first, then by
     *  conversation recency; the row currently in effect is pre-selected, so the popup opens showing
     *  what you are looking at rather than making you find it. */
    private fun chooseSessionPopup(project: Project, entries: List<SessionRow>): com.intellij.openapi.ui.popup.JBPopup {
        val settings = com.cellobservatory.observatory.settings.ObservatorySettings.instance
        val pinned = settings.state.session?.takeIf { it.isNotBlank() }
        val auto = project.basePath?.let { com.cellobservatory.observatory.core.SessionResolver.resolveSessionId(it) }
        val autoLabel = "Auto — newest for this workspace" + (auto?.let { " ($it)" } ?: "")
        val labelToId = LinkedHashMap<String, String?>()
        labelToId[autoLabel] = null
        var selected = autoLabel
        // Live session first (it is the answer most of the time), then everything else newest-first.
        for (s in entries.sortedByDescending { it.current }) {
            val mark = if (s.current) "● " else ""
            // The 8-char id keeps labels unique when two sessions share a title (the map is label-keyed).
            val label = "$mark${s.displayName}  —  ${s.id.take(8)} · ${relTime(s.lastActiveMs)}" +
                (if (s.current) " · active" else "")
            labelToId[label] = s.id
            if (s.id == pinned) selected = label
        }
        return com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labelToId.keys.toList())
            .setTitle("Review which session?")
            .setSelectedValue(selected, true)
            .setItemChosenCallback { chosen -> applySessionChoice(project, labelToId[chosen]) }
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

    /** Cancellable sibling of [runBg] — the replay is ~20 s and Cancel has to actually stop it. */
    private fun runBgCancellable(project: Project, title: String, work: (ProgressIndicator) -> Unit) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, true) {
            override fun run(indicator: ProgressIndicator) = work(indicator)
        })
    }

    // --- demo mode (0.8.9) ---------------------------------------------------------------------------

    /**
     * Replay the demo session and open the guided tour. Starting it again RESETS it: core clears any
     * previous demo for this folder before replaying, so Start and Restart are the same operation and
     * the two cannot drift apart.
     *
     * Streamed rather than spawn-and-waited, so the progress bar narrates each beat, the panels refresh
     * as the beats land, and Cancel stops the run instead of detaching from it.
     */
    fun startDemo(project: Project) {
        val root = project.basePath
        if (root == null) {
            notify(project, "Open a project first — the demo records against a workspace.", NotificationType.WARNING)
            return
        }
        TourController.getInstance(project).stop() // a restart mid-tour starts the tour over too
        // `commonDir` is core's; the CLI reports the same fact by leaving `sibling` null, so ask it once
        // up front rather than inferring "no fleet" from an empty tab later.
        val noRepo = !File(root).let { generateSequence(it) { d -> d.parentFile }.any { File(it, ".git").exists() } }
        runBgCancellable(project, "Replaying a Claude Observatory demo") { indicator ->
            indicator.isIndeterminate = true
            val res = ObservatoryCli.demoStreaming(emptyList(), root, { indicator.isCanceled }) { line ->
                indicator.text2 = line
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) ObservatoryService.getInstance(project).refresh(force = true)
                }
            }
            val cancelled = indicator.isCanceled
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                // The demo wrote real files; pull them into VFS or the editors show yesterday's tree.
                refreshRecursive(root)
                val session = ObservatoryCli.demoSessionFrom(res.stdout) ?: ObservatoryCli.demoSession(root)
                ObservatoryService.getInstance(project).demoSessionOverride = session
                when {
                    // A run that exited non-zero left a PARTIAL demo, and a resolvable session id is not
                    // evidence it finished — reporting success there sends the tour on to narrate panels
                    // the aborted run never populated.
                    (session == null || !res.ok) && !cancelled ->
                        notify(project, "The demo did not finish — ${res.stderr.take(160).ifBlank { "the claude-observatory CLI reported no reason" }}", NotificationType.ERROR)
                    // Stopping is not a failure and not a dead end: what landed is real, and both ways
                    // out are one CLICK away, not merely named in prose.
                    cancelled -> NotificationGroupManager.getInstance()
                        .getNotificationGroup("Claude Observatory")
                        .createNotification("Demo stopped. What landed is real and reviewable.", NotificationType.INFORMATION)
                        .addAction(com.intellij.openapi.actionSystem.ActionManager.getInstance().getAction("ClaudeObservatory.RestartDemo"))
                        .addAction(com.intellij.openapi.actionSystem.ActionManager.getInstance().getAction("ClaudeObservatory.ExitDemo"))
                        .notify(project)
                    else -> {
                        // The fleet correlates on a repo key, so outside a git repo there is nothing to
                        // correlate — say so, rather than letting the tour's Fleet step describe two
                        // agents over an empty tab.
                        if (noRepo) notify(project, "This folder is not a git repository, so the Fleet tab has no worktrees to correlate. Every other panel is populated.")
                        TourController.getInstance(project).start { msg -> notify(project, msg, NotificationType.WARNING) }
                    }
                }
            }
        }
    }

    /** Leave demo mode and remove every trace: both sessions, their stores, the demo folder, and the
     *  report the scenario wrote outside the workspace. */
    fun exitDemo(project: Project) {
        val root = project.basePath
        TourController.getInstance(project).stop()
        ObservatoryService.getInstance(project).demoSessionOverride = null
        // Close the demo's files FIRST. The tour deliberately opens one, and a buffer saved after the
        // folder is deleted recreates a file inside it — taking the `.observatory-demo` sentinel's tree
        // with it, so nothing may ever delete that folder again. Nothing in a demo file is worth keeping.
        val ws = root?.let { File(it, "observatory-demo").path }
        if (ws != null) {
            val fem = FileEditorManager.getInstance(project)
            fem.openFiles.filter { it.path.startsWith(ws + File.separator) }.forEach { fem.closeFile(it) }
        }
        runBg(project, "Removing the demo…") {
            val r = ObservatoryCli.demoClean(root)
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                root?.let { refreshRecursive(it) }
                ObservatoryService.getInstance(project).refresh(force = true)
                // Report what was REMOVED, not what removal was attempted: cleanup is best-effort per
                // item, so a locked or read-only folder makes "the folder is gone" a false claim.
                val removed = if (r.ok) parseCleanResult(r.stdout) else null
                when {
                    removed == null -> notify(project, "Could not remove the demo — ${r.stderr.take(160)}", NotificationType.ERROR)
                    removed.isEmpty() -> notify(project, "Nothing to remove — no demo is recorded for this folder.")
                    else -> notify(project, "Demo removed — ${removed.joinToString(", ")}.")
                }
            }
        }
    }

    /** What `demo --clean --json` says it actually reclaimed, as phrases for the confirmation. */
    private fun parseCleanResult(stdout: String): List<String>? = try {
        val o = com.google.gson.JsonParser.parseString(stdout).asJsonObject
        fun n(k: String) = o.getAsJsonArray(k)?.size() ?: 0
        buildList {
            if (n("sessions") > 0) add("${n("sessions")} session(s)")
            if (n("workspaces") > 0) add("the observatory-demo folder")
            if (n("scratch") > 0) add("the report it wrote outside the workspace")
        }
    } catch (_: Exception) {
        null
    }

    /** True when the panels are currently showing a demo session — including one a crashed IDE left
     *  behind, since demo mode persists no state of its own. Gates the Restart/Exit actions. */
    fun demoPresent(project: Project): Boolean {
        val service = ObservatoryService.getInstance(project)
        if (service.demoSessionOverride != null) return true
        if (ObservatoryCli.isDemoSession(service.currentSession())) return true
        // Session resolution follows the newest transcript, so one real Claude turn after a demo — or a
        // window that crashed mid-demo — would otherwise hide Exit at exactly the moment it is needed.
        // Answered from the store reader, not the CLI: this runs from `update()` on every toolbar paint.
        return demoOnDisk(project)
    }

    /** Cheap, cached check for a demo recorded under this project, for the action `update()` path. */
    private val demoOnDiskCache = java.util.concurrent.ConcurrentHashMap<String, Pair<Long, Boolean>>()

    private fun demoOnDisk(project: Project): Boolean {
        val base = project.basePath ?: return false
        val now = System.currentTimeMillis()
        demoOnDiskCache[base]?.let { (at, v) -> if (now - at < 3_000) return v }
        val found = runCatching {
            java.nio.file.Files.list(com.cellobservatory.observatory.core.ClaudePaths.projectDir(base)).use { s ->
                s.map { it.fileName.toString() }
                    .filter { it.endsWith(".jsonl") }
                    .anyMatch { ObservatoryCli.isDemoSession(it.removeSuffix(".jsonl")) }
            }
        }.getOrDefault(false)
        demoOnDiskCache[base] = now to found
        return found
    }

    /**
     * The single place a session choice is applied. While demo mode is on it moves the IN-MEMORY
     * override; otherwise it writes the persisted pin as before.
     *
     * Two reasons this has to be one function. A pin written during a demo would be invisible — the
     * override wins in `currentSession()`, so the Sessions tab would look broken exactly where the tour
     * says "selecting one switches the whole observatory to it". And it would OUTLIVE the demo: Exit
     * clears the override and deletes the session, leaving every panel pinned to a session that no
     * longer exists, which is the failure the override was introduced to avoid.
     */
    fun applySessionChoice(project: Project, id: String?) {
        val service = ObservatoryService.getInstance(project)
        if (service.demoSessionOverride != null) {
            service.demoSessionOverride = id // its setter already forces the refresh
            return
        }
        com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.session = id
        for (p in com.intellij.openapi.project.ProjectManager.getInstance().openProjects) {
            ObservatoryService.getInstance(p).refresh(force = true)
        }
    }

    /** Every mutating op lands here, so this is where the refresh is FORCED: the throttled views must not
     *  answer a post-mutation refresh from a spawn that started before it, or the panel keeps showing the
     *  counts the mutation just changed. */
    private fun done(project: Project, msg: String, type: NotificationType = NotificationType.INFORMATION) {
        ApplicationManager.getApplication().invokeLater {
            ObservatoryService.getInstance(project).refresh(force = true)
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
            ObservatoryService.getInstance(project).refresh(force = true)
            status(project, msg)
        }
    }
}
