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

/** Sidebar review window (VS Code activity-bar analog): Edits + Diffs + File History. */
class ObservatoryToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        val cm = toolWindow.contentManager
        cm.addContent(iconTab(factory, EditsTreePanel(project, EditsTreePanel.Mode.EDITS), "Edits", Icons.Microscope))
        cm.addContent(iconTab(factory, EditsTreePanel(project, EditsTreePanel.Mode.DIFFS), "Diffs", AllIcons.Actions.Diff))
        cm.addContent(iconTab(factory, FileHistoryPanel(project), "File History", AllIcons.Vcs.History))
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

/** Bottom dashboards window (VS Code panel analog, next to Terminal/Problems): Actions, Observations,
 *  Timeline, Change Map, and Stats side by side in one split — all visible at once, dividers
 *  draggable, each pane carrying its name in a header. Pane order mirrors the VS Code panel's
 *  default so the two editors read the same left-to-right. */
class ObservatoryDashboardsFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val stats = com.cellobservatory.observatory.ui.stats.StatsPanel(project)
        val right = com.intellij.ui.OnePixelSplitter(false, 0.62f).apply {
            firstComponent = titled("Change Map", ChangeMapPanel(project))
            secondComponent = titled("Stats", stats)
        }
        val mid = com.intellij.ui.OnePixelSplitter(false, 0.42f).apply {
            firstComponent = titled("Timeline", TimelinePanel(project))
            secondComponent = right
        }
        val obs = com.intellij.ui.OnePixelSplitter(false, 0.38f).apply {
            firstComponent = titled("Observations", ObservationsPanel(project))
            secondComponent = mid
        }
        val split = com.intellij.ui.OnePixelSplitter(false, 0.16f).apply {
            firstComponent = titled("Actions", ActionsPanel(project))
            secondComponent = obs
        }
        val content = ContentFactory.getInstance().createContent(split, "", false)
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
