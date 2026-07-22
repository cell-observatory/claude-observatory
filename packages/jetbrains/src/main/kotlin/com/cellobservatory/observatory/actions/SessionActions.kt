package com.cellobservatory.observatory.actions

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.services.ObservatoryService
import com.cellobservatory.observatory.ui.ReviewOps
import com.cellobservatory.observatory.ui.inline.InlineOverlay
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages

/**
 * Session-level utility actions, registered in plugin.xml so the panel-only commands (Setup Check,
 * Export, Switch Session, Clean Store, Accept/Revert All, Clear Resolved, Spotlight, Search, Install
 * Hooks) are reachable from Find Action and can be keybound — parity with VS Code, where the same
 * commands live in the palette. Each reuses the SAME shared handler the tree toolbars call (ReviewOps
 * / the service), so behavior never forks.
 */

private fun sessionOrNotify(project: Project): String? {
    val s = ObservatoryService.getInstance(project).currentSession()
    if (s == null) ReviewOps.notify(project, "No active Claude Code session for this project", NotificationType.WARNING)
    return s
}

/** A session-level action gated only on having a project (the handlers notify when no session/edits).
 *  Public (not file-private) so the public, reflectively-instantiated subclasses don't expose a less-
 *  visible supertype. */
abstract class SessionAction : AnAction(), DumbAware {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
    override fun update(e: AnActionEvent) { e.presentation.isEnabled = e.project != null }
}

/** Run `doctor` and open the setup diagnostics (hooks, PATH, config, session, status line) in a tab. */
class SetupCheckAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.openDoctor(e.project ?: return)
    }
}

/** Export a shareable markdown review summary (kept/reverted per file) and open it in an editor tab. */
class ExportReviewSummaryAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        ReviewOps.openMarkdown(
            project, "claude-review-summary",
            "Could not generate a review summary (is the claude-observatory CLI installed?)",
        ) { ObservatoryCli.summaryMarkdown(s, project.basePath) }
    }
}

/** Pin which capture session the observatory shows (the Switch-Session chooser). */
class SwitchSessionAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.chooseSession(e.project ?: return)
    }
}

/** Store maintenance: GC orphaned blobs, or drop the whole session. */
class CleanStoreAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.cleanStore(e.project ?: return)
    }
}

/** Install the PreToolUse/PostToolUse capture hooks (`claude-observatory init`). */
class InstallHooksAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ReviewOps.installHooks(e.project ?: return)
    }
}

/** Accept every pending Claude edit in the session. */
class AcceptAllEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        ReviewOps.keepAll(project, s)
    }
}

/** Revert every pending Claude edit in the session (with the dirty-buffer guard + confirm). */
class RevertAllEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        ReviewOps.undoAll(project, s, ObservatoryService.getInstance(project).log(), "this session")
    }
}

/** Re-apply every undone Claude edit in the session (the forward mirror of Revert All). */
class RedoAllEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        ReviewOps.redoAll(project, s, ObservatoryService.getInstance(project).log(), "this session")
    }
}

/** Clear the resolved (kept/undone) edits from the session log; pending edits are kept. */
class ClearResolvedEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val s = sessionOrNotify(project) ?: return
        val resolved = ObservatoryService.getInstance(project).log().count { !it.pending }
        if (resolved > 0) ReviewOps.clearResolved(project, s, resolved)
        else ReviewOps.notify(project, "No resolved edits to clear")
    }
}

/** Toggle Spotlight — dim the unedited lines to foreground Claude's changes. */
class SpotlightAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        InlineOverlay.getInstance(e.project ?: return).toggleHeatmap()
    }
}

/** Filter the Edits/Diffs trees by file path (empty clears) — the shared Search filter. */
class SearchEditsAction : SessionAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val service = ObservatoryService.getInstance(project)
        val q = Messages.showInputDialog(
            project, "Filter edits by file path (empty to clear):", "Search Edits",
            null, service.filterQuery, null,
        )
        if (q != null) service.setFilter(q)
    }
}
