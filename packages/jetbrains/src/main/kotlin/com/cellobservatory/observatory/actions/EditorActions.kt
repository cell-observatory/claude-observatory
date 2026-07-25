package com.cellobservatory.observatory.actions

import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.Navigate
import com.cellobservatory.observatory.ui.ReviewOps
import com.cellobservatory.observatory.ui.RevisionNav
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbAware

/** ⌥⌘N — step to the next pending edit, cycling through all of them (the keyboard review loop). */
class ReviewNextAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        val next = service.nextPendingEdit()
            ?: return ReviewOps.notify(project, "No pending Claude edits — all caught up")
        Navigate.openFileAtEdit(project, session, next)
    }
}

/** ⌥⌘P — step to the previous pending edit, cycling through all of them (the keyboard review loop). */
class ReviewPrevAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
            ?: return ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
        val prev = service.prevPendingEdit()
            ?: return ReviewOps.notify(project, "No pending Claude edits — all caught up")
        Navigate.openFileAtEdit(project, session, prev)
    }
}

/** ⌥⌘Y — keep the pending edit under the cursor. */
class KeepAtCursorAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        Navigate.pendingAtCursor(project, editor) { rec ->
            if (rec == null) {
                ReviewOps.notify(project, "No pending Claude edit at the cursor")
            } else {
                val session = ObservatoryService.getInstance(project).currentSession() ?: return@pendingAtCursor
                ReviewOps.keep(project, session, rec.id)
            }
        }
    }
}

/** ⌥⌘U — surgically undo the pending edit under the cursor. */
class UndoAtCursorAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        Navigate.pendingAtCursor(project, editor) { rec ->
            if (rec == null) {
                ReviewOps.notify(project, "No pending Claude edit at the cursor")
            } else {
                val session = ObservatoryService.getInstance(project).currentSession() ?: return@pendingAtCursor
                ReviewOps.undoOrRedo(project, session, rec, redo = false)
            }
        }
    }
}

/** ⌥⌘[ — diff the current file against the state the previous Claude edit produced. */
class DiffPrevRevisionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        RevisionNav.step(project, editor, -1)
    }
}

/** ⌥⌘] — diff the current file against the state the next Claude edit produced. */
class DiffNextRevisionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.EDITOR) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return
        RevisionNav.step(project, editor, 1)
    }
}

/** ⌃⌥K / ⌘⌥K — accept every pending edit in the active file (parity: VS Code keepOpenFile). */
class KeepOpenFileAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.VIRTUAL_FILE) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return
        val targets = service.log().filter { it.file == vf.path }
        ReviewOps.keepAll(project, session, targets, vf.name)
    }
}

/** ⌃⌥R / ⌘⌥R — revert every pending edit in the active file (parity: VS Code undoOpenFile). */
class UndoOpenFileAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null && e.getData(CommonDataKeys.VIRTUAL_FILE) != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val vf = e.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return
        val targets = service.log().filter { it.file == vf.path }
        // `under = vf.path` scopes the revert to this file; omitting it makes undoScope run
        // `undo --all` across the whole session (matches EditsTreePanel/FileHistory/ReviewNavBar).
        ReviewOps.undoAll(project, session, targets, vf.name, vf.path)
    }
}
