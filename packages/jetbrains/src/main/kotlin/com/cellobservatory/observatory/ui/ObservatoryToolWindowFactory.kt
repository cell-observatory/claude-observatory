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

/** Sidebar review window (VS Code activity-bar analog): Edits + Diffs + File History + Actions. */
class ObservatoryToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        val cm = toolWindow.contentManager
        cm.addContent(iconTab(factory, EditsTreePanel(project, EditsTreePanel.Mode.EDITS), "Edits", Icons.Microscope))
        cm.addContent(iconTab(factory, EditsTreePanel(project, EditsTreePanel.Mode.DIFFS), "Diffs", AllIcons.Actions.Diff))
        cm.addContent(iconTab(factory, FileHistoryPanel(project), "File History", AllIcons.Vcs.History))
        // Actions timeline — moved out of the Observations dock window (0.8.0 r4), pinned at the bottom.
        cm.addContent(iconTab(factory, ActionsPanel(project), "Actions", AllIcons.Debugger.Console))
    }

    /** An icon-only tab: the glyph is the tab, its name rides in the hover tooltip + overflow chooser. */
    private fun iconTab(factory: ContentFactory, component: JComponent, label: String, icon: Icon): Content =
        factory.createContent(component, "", false).apply {
            this.icon = icon          // Content.setIcon — the tab glyph
            description = label        // Content.setDescription — the hover tooltip
            popupIcon = icon           // shown in the tab-overflow chooser
            isCloseable = false
        }
}

/** Bottom dashboards window (VS Code panel analog, next to Terminal/Problems). 0.8.0 r3 consolidation —
 *  three panes side by side in one split (dividers draggable, each pane carrying its name):
 *    · Observations — TABBED (Observations timeline | Actions timeline).
 *    · Overview     — the combined MASTER–DETAIL: a Fleet · Workflows nav on the left (the former
 *                     standalone Multitasking window, folded in) driving the change-map detail on the right.
 *    · Stats        — session metrics.
 *  The standalone Multitasking / Actions / Timeline panes are gone — Multitasking's fleet+workflows fold
 *  into the Overview, its Actions fold into Observations, and Timeline folds into Observations. */
class ObservatoryDashboardsFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val stats = com.cellobservatory.observatory.ui.stats.StatsPanel(project)
        // Overview is now a two-column master-detail (nav + change-map), so it takes the larger share.
        val right = com.intellij.ui.OnePixelSplitter(false, 0.63f).apply {
            firstComponent = titled("Overview", ChangeMapPanel(project))
            secondComponent = titled("Stats", stats)
        }
        val split = com.intellij.ui.OnePixelSplitter(false, 0.3f).apply {
            firstComponent = titled("Observations", ObservationsPanel(project))
            secondComponent = right
        }
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
