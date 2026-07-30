package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ChatRef
import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.model.SessionPrompt
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

    /** Bulk-revert refusals (e.g. the #43 phantom guard) appended to the toast — the refusal message
     *  names the remediation (`clean --phantoms`), and swallowing it leaves totals that don't add up. */
    private fun refusedSuffix(res: ObservatoryCli.UndoScopeResult): String =
        if (res.errors > 0) " · ${res.errors} refused — ${res.firstError ?: ""}" else ""

    fun keep(project: Project, session: String, id: Int, advance: Boolean = true) {
        runBg(project, "Keeping edit #$id") {
            // Routine single-edit keep → transient status bar (no Event Log pile-up); failures stay balloons.
            if (ObservatoryCli.keep(session, id, project.basePath)) {
                doneQuiet(project, "Kept edit #$id")
                // Queued AFTER doneQuiet's refresh, so advanceAfterResolve reads the POST-keep log — its
                // "did this record actually leave pending" gate is the whole point and a stale log would
                // answer it wrong.
                ApplicationManager.getApplication().invokeLater {
                    advanceAfterResolve(project, session, id, redo = false, advance = advance)
                }
            } else {
                done(project, cliFailMsg("keep edit #$id"), NotificationType.ERROR)
            }
        }
    }

    /**
     * After a SINGLE keep/undo, open the next edit still awaiting review — in another file when that is
     * where it is (`revealNextOnResolve`, default on; VS Code parity). Call on the EDT.
     *
     * Three gates, each for a failure it prevents. The setting, because a cursor that jumps out of the
     * file you were reading has to be refusable. [redo], because this is reached from the shared tail of
     * undo AND redo, and a redo resolves nothing — VS Code advances on neither redo nor any bulk op, so
     * an ungated hook would be a silent cross-editor divergence. And the record having actually left
     * `pending`, so a CLI failure, a dirty-buffer block or a cancelled conflict never moves the cursor.
     *
     * Parking the cursor on the RESOLVED id first is what makes the step land "just past it":
     * [ObservatoryService.nextPendingEdit] resumes from a cursor whose edit is gone rather than wrapping.
     */
    internal fun advanceAfterResolve(project: Project, session: String, id: Int, redo: Boolean, advance: Boolean = true) {
        val next = nextAfterResolve(project, id, redo, advance) ?: return
        Navigate.openFileAtEdit(project, session, next)
    }

    /** The cursor half of [advanceAfterResolve], split off so the three gates are testable without an
     *  editor, a VFS refresh or a `locate` spawn: the edit to open, or null when this resolve must leave
     *  the cursor alone. Moves the cursor only on the paths that return non-null. */
    internal fun nextAfterResolve(project: Project, id: Int, redo: Boolean, advance: Boolean = true): EditRecord? {
        // A surface that opts out is checked FIRST, so this stays callable in a test with no editor at all.
        // The diff viewer opts out: it is a window the reader opened deliberately to read, and revealing a
        // DIFFERENT file behind it (Navigate focuses the editor) throws them out of what they were doing.
        // VS Code's diff title bar makes the same exception, so honouring it here is parity, not taste.
        if (!advance) return null
        if (redo) return null
        if (!com.cellobservatory.observatory.settings.ObservatorySettings.instance.state.revealNextOnResolve) return null
        if (project.isDisposed) return null
        val service = ObservatoryService.getInstance(project)
        if (service.log().any { it.id == id && it.pending }) return null // never left pending — nothing resolved
        service.parkReviewCursor(id)
        return service.nextPendingEdit() // null when all caught up; the toast already said so
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
    fun undoOrRedo(project: Project, session: String, rec: EditRecord, redo: Boolean, advance: Boolean = true) {
        val verb = if (redo) "Redo" else "Undo"
        if (!ensureSaved(project, rec.file, verb)) return
        runBg(project, "$verb edit #${rec.id}") {
            val res = if (redo) ObservatoryCli.redo(session, rec.id, force = false, project.basePath)
            else ObservatoryCli.undo(session, rec.id, force = false, project.basePath)
            ApplicationManager.getApplication().invokeLater {
                afterUndo(project, session, rec, res, redo, advance)
            }
        }
    }

    private fun afterUndo(project: Project, session: String, rec: EditRecord, res: UndoResult, redo: Boolean, advance: Boolean = true) {
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
        // This is the shared tail of undo AND redo (one call site, in undoOrRedo) — the `redo` flag is
        // what keeps the auto-advance off the redo path. The refresh above already re-keyed the log, so
        // the pending check inside reads post-mutation state.
        advanceAfterResolve(project, session, rec.id, redo, advance)
    }

    /**
     * Revert every pending edit in a SESSION, via `undo --all --session <id>` — no local records.
     *
     * The record-taking overload pairs ids with a log, which is only safe when both come from the same
     * session. The Overview toolbar can be scoped to a sibling, so it uses this instead: the CLI resolves
     * the set from the session it is given, and nothing can cross a session boundary.
     */
    fun undoAllInSession(project: Project, session: String) {
        val ok = Messages.showYesNoDialog(
            project,
            "Revert every pending edit in this session?\n\nThis rewrites files on disk. Accepted edits are left alone.",
            "Claude Observatory",
            "Revert All",
            "Cancel",
            Messages.getWarningIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Reverting all pending edits") {
            val r = ObservatoryCli.undoScope(session, null, project.basePath)
            ApplicationManager.getApplication().invokeLater {
                if (r == null) notify(project, cliFailMsg("revert the session"), NotificationType.ERROR)
                else {
                    ObservatoryService.getInstance(project).refresh(force = true)
                    VfsUtil.markDirtyAndRefresh(true, true, true, *arrayOf(LocalFileSystem.getInstance().findFileByPath(project.basePath ?: "")).filterNotNull().toTypedArray())
                    notify(
                        project,
                        "Reverted ${r.undone} of ${r.total} pending edit(s)." + refusedSuffix(r),
                        if (r.errors > 0) NotificationType.WARNING else NotificationType.INFORMATION,
                    )
                }
            }
        }
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
                    "Reverted ${res.undone} edit(s)" +
                        (if (res.conflicts > 0) " · ${res.conflicts} conflict(s) — undo those individually to force" else "") +
                        refusedSuffix(res),
                    if (res.errors > 0) NotificationType.WARNING else NotificationType.INFORMATION,
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
                        (if (res.conflicts > 0) " · ${res.conflicts} conflict(s) — revert those individually to force" else "") +
                        refusedSuffix(res),
                    if (res.errors > 0) NotificationType.WARNING else NotificationType.INFORMATION,
                )
            }
        }
    }

    /**
     * Rewind to before one ask: revert every pending edit that ask and everything after it produced.
     *
     * The coarsest destructive verb in the product — Copilot's "Restore Checkpoint" — and the boundary is
     * core's, not this plugin's: `undo --from-prompt <id>` resolves the window and expands every same-code
     * group, so a chain straddling the boundary reverts whole instead of half.
     *
     * The three numbers in the confirmation are the CLI's, never this plugin's: `undo --from-prompt <id>
     * --dry-run --json` counts the very scope the revert will act on ([ObservatoryCli.previewRewind],
     * called below), so both editors state the same numbers at the point of commitment — VS Code reaches
     * that same core scope in-process. Counting here instead is not an option: the revert acts on RAW
     * store ids after group expansion, and the display units the Prompts rows show differ from the CLI's
     * unit count whenever a group's representative is already resolved.
     *
     * The count-free sentence in [confirmRewind] is the FALLBACK, reached only when the preflight cannot
     * answer — a pre-0.10 CLI that got past [ObservatoryCli.supportsFromPrompt] because its `--version`
     * was unparseable, a spawn that failed, output this build cannot read. There it follows the rule
     * [clearResolved]'s sibling-session path follows for the same reason: name the scope and let the CLI
     * report what it did, because a destructive dialog stating a number the result then contradicts is
     * worse than one that states none. Deleting the preflight would silently drop both editors back to
     * that fallback.
     */
    fun rewindFromPrompt(project: Project, session: String, prompt: SessionPrompt) {
        // The version preflight runs FIRST and off the EDT: `--from-prompt` is a 0.10 flag, and asking
        // someone to confirm a destructive revert we then refuse is worse than not offering it. Never from
        // an action `update()` — it spawns, and update() runs per toolbar tick. Memoized per work dir, so
        // this costs one spawn per IDE session.
        runBg(project, "Checking the rewind boundary…") {
            val supported = ObservatoryCli.supportsFromPrompt(project.basePath)
            // Both spawns in ONE background hop, so the dialog opens on the EDT with its numbers already in
            // hand. Not memoized: the scope shrinks with every keep and undo, so a cached count would name
            // work that is no longer pending.
            val preview = if (supported) ObservatoryCli.previewRewind(session, prompt.id, project.basePath) else null
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                if (!supported) {
                    notify(
                        project,
                        "Rewind needs claude-observatory 0.10 or newer — run `claude-observatory update`.",
                        NotificationType.WARNING,
                    )
                } else {
                    confirmRewind(project, session, prompt, preview)
                }
            }
        }
    }

    private fun confirmRewind(
        project: Project,
        session: String,
        prompt: SessionPrompt,
        preview: ObservatoryCli.RewindPreview?,
    ) {
        val label = "#${prompt.index}" + prompt.title.takeIf { it.isNotBlank() }?.let { " “$it”" }.orEmpty()
        // The preflight was meant to COUNT. A build that dropped the flag and reverted instead has already
        // rewritten files with no confirmation, so say so loudly and stop — running the revert a second time
        // would compound it, and staying quiet would leave the reader to discover it from the store.
        if (preview != null && preview.performed) {
            ObservatoryService.getInstance(project).refresh(force = true)
            project.basePath?.let { refreshRecursive(it) }
            notify(
                project,
                "The claude-observatory CLI on PATH ignored `--dry-run` and already reverted " +
                    "${preview.pending} edit(s) from prompt $label onward, without confirming first. " +
                    "Nothing further was done — run `claude-observatory update` before rewinding again.",
                NotificationType.ERROR,
            )
            return
        }
        // A real prompt with nothing pending from it onward: say so instead of confirming a no-op.
        if (preview != null && preview.pending == 0) {
            return notify(project, "Nothing to rewind — no pending edits from prompt $label onward.")
        }
        // Every file in the workspace can be in scope, so save everything dirty rather than the per-file
        // list the narrower verbs build — we do not know which files until the CLI answers. Before the
        // confirm, matching undoAll/undoIds/redoAll: a refusal to save ends it without a second dialog.
        val dirty = ObservatoryService.getInstance(project).log()
            .filter { it.pending }.map { it.file }.distinct().filter { isDirty(it) }
        if (dirty.isNotEmpty() && !confirmSaveAll(project, dirty)) return
        // The same three numbers as VS Code and the same commitments (what is reverted, that redo restores
        // it, that overlaps may conflict), in JetBrains-idiomatic wording: this dialog writes "(s)" where
        // VS Code pluralizes, and adds the second paragraph below. Both resolve the same core scope, so the
        // NUMBERS cannot drift. Indexed by #i rather than by title for that parity — the opening question
        // is VS Code's word for word; the toast afterwards names the ask.
        val scope = preview?.let { p ->
            "This reverts ${p.pending} pending edit(s) (${p.units} review unit(s))" +
                // A file count of 0 alongside pending work means the build did not report the list — drop
                // the clause rather than print a zero.
                (if (p.files > 0) " across ${p.files} file(s)" else "") +
                " made from this ask onward — including asks after it — by rewriting those files on disk. " +
                "Redo can restore them. Overlapping edits may conflict."
        } ?: // No preflight (an old CLI, or a call that failed): name the scope, never a guessed number.
            "This reverts every pending edit made from this ask onward — including asks after it — by " +
                "rewriting those files on disk. Redo can restore them. Overlapping edits may conflict " +
                "(revert those individually to force-restore)."
        val ok = Messages.showYesNoDialog(
            project,
            "Rewind to before prompt #${prompt.index}?\n\n$scope\n\n" +
                "Accepted edits are left alone, and edits captured before the session's first ask are " +
                "outside every boundary and are never included.",
            "Rewind Claude's Edits",
            "Rewind", "Cancel", Messages.getWarningIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Rewinding to before prompt #${prompt.index}") {
            // The stable 12-hex id, never the index: an index is a position in a list that grows with
            // every ask, so a panel one refresh out of date would rewind the wrong one.
            val out = ObservatoryCli.undoFromPrompt(session, prompt.id, project.basePath)
            project.basePath?.let { refreshRecursive(it) } // the scope can span the whole workspace
            val res = out.result
            if (res == null) {
                done(project, "Could not rewind to before prompt $label — ${out.error ?: "the CLI gave no reason"}", NotificationType.ERROR)
                return@runBg
            }
            // A real prompt whose scope holds nothing pending is a normal, successful zero — the CLI exits 0
            // and says so. Reporting it as "Reverted 0 edit(s) across 0 file(s)" reads like a failure.
            if (res.undone == 0 && res.conflicts == 0 && res.errors == 0) {
                done(project, "Nothing to rewind — no pending edits from prompt $label onward.")
                return@runBg
            }
            // Every number here is the CLI's own, mapped through the log only to name the files: `undone`
            // is what actually reverted, `units` the review units those records collapse to (what the
            // Prompts rows count), and the file count comes from the very ids the CLI reported. An older
            // CLI reports no ids, and then the file clause is DROPPED rather than printed as zero.
            val byId = ObservatoryService.getInstance(project).log().associateBy { it.id }
            val files = res.ids.mapNotNull { byId[it]?.file }.distinct().size
            val units = res.units?.let { " ($it review unit(s))" } ?: ""
            val across = if (files > 0) " across $files file(s)" else ""
            val msg = "Reverted ${res.undone} pending edit(s)$units$across from prompt $label onward" +
                (if (res.conflicts > 0) " · ${res.conflicts} conflict(s) — revert those individually to force" else "") +
                refusedSuffix(res)
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                ObservatoryService.getInstance(project).refresh(force = true)
                val type = if (res.errors > 0 || res.conflicts > 0) NotificationType.WARNING else NotificationType.INFORMATION
                val n = NotificationGroupManager.getInstance()
                    .getNotificationGroup("Claude Observatory")
                    .createNotification(msg, type)
                // Redo is the promise the dialog made, so it is a BUTTON, not prose. It restores THESE ids —
                // the ones this rewind actually moved — never the scope re-resolved, which would also
                // re-apply an edit the reader had rejected before the rewind ran.
                if (res.ids.isNotEmpty()) {
                    n.addAction(
                        com.intellij.notification.NotificationAction.createSimpleExpiring("Redo the rewind") {
                            redoRewind(project, session, res.ids, label)
                        },
                    )
                }
                n.notify(project)
            }
        }
    }

    /**
     * The Redo button on a rewind's toast: re-apply exactly the ids that rewind reverted.
     *
     * Keyed on the ids rather than on the prompt, because the prompt's scope includes every record in the
     * window whatever its status — re-resolving it would resurrect an edit the reader had rejected before
     * the rewind, and the toast would count it without naming it.
     */
    private fun redoRewind(project: Project, session: String, ids: List<Int>, label: String) {
        runBg(project, "Restoring the edits rewound from prompt $label onward") {
            val out = ObservatoryCli.redoScopeIds(session, ids, project.basePath)
            project.basePath?.let { refreshRecursive(it) }
            val res = out.result
            if (res == null) {
                done(project, "Could not restore prompt $label onward — ${out.error ?: "the CLI gave no reason"}", NotificationType.ERROR)
                return@runBg
            }
            if (res.redone == 0 && res.conflicts == 0) {
                done(project, "Nothing to restore — the rewound edits from prompt $label onward are no longer undone.")
                return@runBg
            }
            done(
                project,
                "Re-applied ${res.redone} edit(s) from prompt $label onward" +
                    if (res.conflicts > 0) " · ${res.conflicts} conflict(s) — redo those individually to force" else "",
                if (res.conflicts > 0) NotificationType.WARNING else NotificationType.INFORMATION,
            )
        }
    }

    /** [resolvedCount] null = unknown (a sibling session — its log is not loaded here): the dialog is
     *  phrased count-free and the toast reports the CLI's own figure, never an interpolated sentinel. */
    fun clearResolved(project: Project, session: String, resolvedCount: Int?) {
        val what = resolvedCount?.let { "$it resolved edit(s)" } ?: "this session's resolved edits"
        val ok = Messages.showYesNoDialog(
            project, "Clear $what from the log? Pending edits are kept.",
            "Claude Observatory", "Clear", "Cancel", Messages.getQuestionIcon(),
        )
        if (ok != Messages.YES) return
        runBg(project, "Clearing resolved edits") {
            val r = ObservatoryCli.clearResolvedJson(session, project.basePath)
            if (r != null) done(project, "Cleared $r resolved edit(s)")
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
                if (md.isNullOrBlank()) notify(project, errorMsg) else openTextTab(project, name, ".md", md)
            }
        }
    }

    /** The full-session-trace twin of [openMarkdown]: same off-EDT fetch, opens a `.json` tab. */
    fun openJson(project: Project, name: String, errorMsg: String, produce: () -> String?) {
        val app = ApplicationManager.getApplication()
        app.executeOnPooledThread {
            val text = produce()
            app.invokeLater {
                if (text.isNullOrBlank()) notify(project, errorMsg) else openTextTab(project, name, ".json", text)
            }
        }
    }

    /** Write [text] to a temp [ext] file and open it in an editor tab (Export / Doctor / Analyze / Trace). */
    private fun openTextTab(project: Project, name: String, ext: String, text: String) {
        val tmp = java.io.File.createTempFile(name, ext)
        tmp.writeText(text)
        // The platform refuses to load files past idea.max.content.load.filesize (20 MB by default) —
        // for a very large trace, "opening" would show a refusal with no pointer to the data. Naming
        // the file it was written to keeps the export usable.
        if (tmp.length() > 19L * 1024 * 1024) {
            notify(project, "Export written to ${tmp.path} — too large to open in the editor.")
            return
        }
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
                    openTextTab(project, "claude-observatory-analysis-$id", ".md", text)
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
        // Spelled out, never a bare "Clear": this drops whole SESSIONS, where every other clear verb in
        // the product drops resolved EDITS. The two are one keystroke apart and not remotely undoable.
        val completedOpt = "Clear completed sessions — drop finished sessions with nothing left to review"
        val dropOpt = "Drop this session — delete its edits + blobs (files on disk are unchanged)"
        val popup = com.intellij.openapi.ui.popup.JBPopupFactory.getInstance()
            .createPopupChooserBuilder(listOf(gcOpt, completedOpt, dropOpt))
            .setTitle("Clean the store")
            .setItemChosenCallback { chosen ->
                val drop = chosen == dropOpt
                val completed = chosen == completedOpt
                if (completed) {
                    // Popup callbacks run on the EDT, and the counts preview SPAWNS the CLI — inline it
                    // froze the IDE between the popup click and the confirm dialog (~80ms warm, bounded
                    // only by the 30s exec timeout on a slow store). So: preview on a pooled thread,
                    // dialog back on the EDT, and only then the destructive verb in its own task.
                    runBg(project, "Checking completed sessions…") {
                        // Ask the CLI what would actually go, and put THOSE numbers in the dialog. This
                        // used to be prose alone, so the reader confirmed a recursive delete of
                        // unreviewed work without being told how many sessions or how many edits — the
                        // VS Code dialog has always led with the counts, and the more destructive
                        // surface should not say less.
                        val preview = ObservatoryCli.cleanCompletedPreview(project.basePath)
                        val doomed: List<Triple<String, String, Int>> = try {
                            com.google.gson.JsonParser.parseString(preview.stdout).asJsonObject
                                .getAsJsonArray("sessions").map { it.asJsonObject }
                                .map {
                                    Triple(
                                        it.get("title")?.takeIf { t -> !t.isJsonNull }?.asString?.ifBlank { null }
                                            ?: it.get("id").asString,
                                        it.get("reason")?.takeIf { r -> !r.isJsonNull }?.asString ?: "finished",
                                        it.get("pending")?.takeIf { p -> !p.isJsonNull }?.asInt ?: 0,
                                    )
                                }
                        } catch (_: Exception) {
                            emptyList()
                        }
                        ApplicationManager.getApplication().invokeLater {
                            if (project.isDisposed) return@invokeLater
                            if (preview.ok && doomed.isEmpty()) {
                                return@invokeLater notify(project, NO_COMPLETED_MSG, NotificationType.INFORMATION)
                            }
                            // A preview we could not read is not a reason to guess a number; fall back to the prose.
                            val lost = doomed.sumOf { it.third }
                            val lead = if (doomed.isEmpty()) {
                                "Clear finished and abandoned sessions?"
                            } else {
                                "Clear ${doomed.size} session(s)?" +
                                    (if (lost > 0) "  $lost edit(s) have never been reviewed and will be DISCARDED." else "") +
                                    "\n\n" + doomed.take(5).joinToString("\n") { "  • ${it.first} (${it.second})" } +
                                    (if (doomed.size > 5) "\n  … and ${doomed.size - 5} more" else "")
                            }
                            val ok = Messages.showYesNoDialog(
                                project,
                                lead + "\n\n" +
                                    "FINISHED means nothing left to review. ABANDONED means the conversation has been dead for " +
                                    "over two weeks and its edits were never reviewed — those unreviewed edits are DISCARDED.\n\n" +
                                    "This deletes their captured edits + blobs. Files on disk are NOT changed.\n\n" +
                                    "Never included: the session you are in, anything mid-capture, anything from another " +
                                    "workspace, anything reviewed-and-quiet for under a day, or anything with pending edits " +
                                    "that is under two weeks old.",
                                "Claude Observatory", "Clear Sessions", "Cancel", Messages.getWarningIcon(),
                            )
                            if (ok == Messages.YES) runClean(project, session, CleanVerb.COMPLETED)
                        }
                    }
                    return@setItemChosenCallback
                }
                if (drop) {
                    val ok = Messages.showYesNoDialog(
                        project, "Drop session $session? This deletes its captured edits + blobs. Files on disk are NOT changed.",
                        "Claude Observatory", "Drop Session", "Cancel", Messages.getWarningIcon(),
                    )
                    if (ok != Messages.YES) return@setItemChosenCallback
                }
                runClean(project, session, if (drop) CleanVerb.DROP else CleanVerb.GC)
            }
            .createPopup()
        if (anchor != null) popup.showInCenterOf(anchor) else popup.showCenteredInCurrentWindow(project)
    }

    /** The three destructive clean verbs, one value each — two booleans made (drop ∧ completed)
     *  representable but meaningless. */
    private enum class CleanVerb { DROP, COMPLETED, GC }

    /** Shared by all clean verbs, phrased once. */
    private const val NO_COMPLETED_MSG =
        "No completed sessions to clear — every other session is still live, still has " +
            "pending edits, or only just went quiet."

    /** The destructive half of cleanStore, in its own background task — the confirm dialogs above stay
     *  pure UI. */
    private fun runClean(project: Project, session: String, verb: CleanVerb) {
        runBg(project, "Cleaning store…") {
                    val r = when (verb) {
                        CleanVerb.DROP -> ObservatoryCli.dropSession(session, project.basePath)
                        CleanVerb.COMPLETED -> ObservatoryCli.cleanCompleted(project.basePath)
                        CleanVerb.GC -> ObservatoryCli.gc(session, project.basePath)
                    }
                    ApplicationManager.getApplication().invokeLater {
                        if (r.ok) {
                            ObservatoryService.getInstance(project).refresh(force = true) // the store just changed
                            notify(
                                project,
                                when {
                                    verb == CleanVerb.DROP -> "Dropped session $session."
                                    // The CLI is the authority on how many qualified; report ITS count, never a
                                    // guess — and never report a deletion that did not happen.
                                    verb == CleanVerb.COMPLETED -> when (val n = droppedCount(r.stdout)) {
                                        null -> "Cleared the completed sessions."
                                        0 -> NO_COMPLETED_MSG
                                        else -> "Cleared $n completed session(s)."
                                    }
                                    else -> "Reclaimed disk (GC complete)."
                                },
                            )
                        } else {
                            notify(project, "Clean failed — ${r.stderr.take(160)}", NotificationType.ERROR)
                        }
                    }
                }
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
     *  listing is sidecar-cached in core — a log is re-parsed only when it changed, so the popup opens without the multi-second
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

    /**
     * How many sessions `clean --completed --json` actually dropped.
     *
     * Read from the CLI's own answer rather than counted here: the eligibility rules live in core, and a
     * second count in the UI is a second definition of "completed" waiting to disagree. Falls back to a
     * count-free message rather than inventing a number if the payload cannot be read.
     */
    private fun droppedCount(stdout: String): Int? = try {
        com.google.gson.JsonParser.parseString(stdout).asJsonObject.getAsJsonArray("dropped")?.size() ?: 0
    } catch (_: Exception) {
        // null, not a string: this value is interpolated into "Cleared $n completed session(s)", and the
        // old "the completed" sentinel rendered as "Cleared the completed completed session(s)."
        null
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
