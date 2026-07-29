package com.cellobservatory.observatory.ui

import com.intellij.icons.AllIcons
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.Content
import com.intellij.ui.content.ContentFactory
import javax.swing.Icon
import javax.swing.JComponent

/** An icon + text tab. The label must be the displayName — the new UI (PyCharm 2025+) renders content
 *  tabs by text and may drop the icon, so an empty displayName leaves the tab blank/invisible.
 *  File-level: both windows below build their tabs with it. */
private fun iconTab(factory: ContentFactory, component: JComponent, label: String, icon: Icon): Content =
    factory.createContent(component, label, false).apply {
        this.icon = icon          // Content.setIcon — the tab glyph
        description = label        // Content.setDescription — the hover tooltip
        popupIcon = icon           // shown in the tab-overflow chooser
        isCloseable = false
    }

/** "Observatory Traces" — the sidebar review window (VS Code activity-bar analog): Edits + Diffs +
 *  File History. 0.9.0: Actions and Observations moved to the Observatory Timeline window, with
 *  Prompts — the timeline-shaped surfaces live together, and this window is purely per-edit review. */
class ObservatoryToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        val cm = toolWindow.contentManager
        cm.addContent(iconTab(factory, EditsTreePanel(project, EditsTreePanel.Mode.EDITS), "Edits", Icons.Microscope))
        cm.addContent(iconTab(factory, EditsTreePanel(project, EditsTreePanel.Mode.DIFFS), "Diffs", AllIcons.Actions.Diff))
        cm.addContent(iconTab(factory, FileHistoryPanel(project), "File History", AllIcons.Vcs.History))
    }
}

/** "Observatory Timeline" — the timeline-shaped surfaces, one window (VS Code's Observatory Timeline
 *  panel container, literally): Prompts · Actions · Observations as tabs, anchored right. 0.9.0 first
 *  grouped Actions + Observations into the Dashboards window "in its own shape"; the literal third
 *  window is what actually matches the product's three-surface layout. */
class ObservatoryTimelineFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        val cm = toolWindow.contentManager
        cm.addContent(iconTab(factory, PromptsPanel(project), "Prompts", AllIcons.Actions.ListFiles))
        cm.addContent(iconTab(factory, ActionsPanel(project), "Actions", AllIcons.Debugger.Console))
        cm.addContent(iconTab(factory, ObservationsPanel(project), "Observations", AllIcons.Actions.IntentionBulb))
    }
}

/** Bottom dashboards window (VS Code panel analog, next to Terminal/Problems). 0.8.7 layout —
 *  three panes side by side in one split (dividers draggable, each pane carrying its name):
 *    · Prompts — what the USER asked for, in order. Selecting one SCOPES the Overview beside it, which
 *                 is why the two are neighbours rather than tabs: you keep the list of asks in view
 *                 while you read what one of them produced.
 *    · Overview — the combined MASTER–DETAIL: a Fleet · Workflows · Tasks · Processes nav on the left
 *                 driving the change-map detail on the right.
 *    · Stats    — session metrics.
 *  Observations moved to the sidebar window (with Edits / Diffs / File History / Actions) to make room. */
class ObservatoryDashboardsFactory : ToolWindowFactory, DumbAware {

    companion object {
        /** One re-apply hook per open project. The fold state lives in APPLICATION settings but each
         *  window owns its own splitter, so a toggle in project A used to leave project B's pane on
         *  screen with its title-bar checkbox reading the new value. Anything that changes the setting
         *  calls [applyPanes], which re-applies it everywhere. */
        private val appliers = java.util.WeakHashMap<Project, () -> Unit>()

        fun applyPanes(project: Project) {
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) appliers.values.toList().forEach { it() }
            }
        }
    }

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val stats = com.cellobservatory.observatory.ui.stats.StatsPanel(project)
        val statsPane = titled("Stats", stats)
        // Overview 81% | Stats 19%. Prompts moved to the Observatory Timeline window (with Actions and
        // Observations), so the dock is just the two panes that must be seen side by side.
        val split = com.intellij.ui.OnePixelSplitter(false, 0.81f).apply {
            firstComponent = titled("Overview", ChangeMapPanel(project))
            secondComponent = statsPane
        }

        // Prompts and Stats FOLD AWAY. This dock is short — a bottom tool window is a few hundred pixels
        // tall — and three columns plus the Overview's own nav bar left the change map with almost
        // nothing. VS Code gets this for free: its three dock views are separate accordion sections the
        // reader collapses individually. The platform equivalent is a title-bar toggle per pane, so the
        // affordance sits in the window's own chrome instead of stealing more room from the panel.
        val state = com.cellobservatory.observatory.settings.ObservatorySettings.instance.state
        fun apply() {
            split.secondComponent = if (state.dashShowStats) statsPane else null
            split.revalidate(); split.repaint()
        }
        fun paneToggle(label: String, icon: Icon, get: () -> Boolean, set: (Boolean) -> Unit) =
            object : com.intellij.openapi.actionSystem.ToggleAction(label, "Show or hide the $label pane", icon),
                DumbAware {
                override fun getActionUpdateThread() = com.intellij.openapi.actionSystem.ActionUpdateThread.BGT
                override fun isSelected(e: com.intellij.openapi.actionSystem.AnActionEvent) = get()
                override fun setSelected(e: com.intellij.openapi.actionSystem.AnActionEvent, on: Boolean) {
                    set(on)
                    applyPanes(project) // every open window, since the setting is application-wide
                }
            }
        toolWindow.setTitleActions(
            listOf(
                paneToggle("Stats", AllIcons.Actions.Profile, { state.dashShowStats }, { state.dashShowStats = it }),
            )
        )
        appliers[project] = ::apply
        apply() // honour whatever the reader last chose

        val factory = ContentFactory.getInstance()
        val content = factory.createContent(split, "Dashboards", false).apply { isCloseable = false }
        // Tie the StatsPanel's Timer + service listener to the content's lifecycle (stopped on close).
        com.intellij.openapi.util.Disposer.register(content, stats)
        toolWindow.contentManager.addContent(content)
    }

    private fun titled(title: String, c: javax.swing.JComponent): javax.swing.JComponent =
        javax.swing.JPanel(java.awt.BorderLayout()).apply {
            add(com.intellij.ui.components.JBLabel(title).apply {
                font = com.intellij.util.ui.JBUI.Fonts.label().deriveFont(java.awt.Font.BOLD)
                border = com.intellij.util.ui.JBUI.Borders.empty(4, 8, 2, 8)
                foreground = com.intellij.util.ui.UIUtil.getContextHelpForeground()
            }, java.awt.BorderLayout.NORTH)
            add(c, java.awt.BorderLayout.CENTER)
        }
}
