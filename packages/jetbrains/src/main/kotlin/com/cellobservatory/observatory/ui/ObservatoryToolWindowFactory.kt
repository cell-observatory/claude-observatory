package com.cellobservatory.observatory.ui

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/** Sidebar review window (VS Code activity-bar analog): Edits + Diffs + File History. */
class ObservatoryToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        toolWindow.contentManager.addContent(
            factory.createContent(EditsTreePanel(project, EditsTreePanel.Mode.EDITS), "Edits", false)
        )
        toolWindow.contentManager.addContent(
            factory.createContent(EditsTreePanel(project, EditsTreePanel.Mode.DIFFS), "Diffs", false)
        )
        toolWindow.contentManager.addContent(
            factory.createContent(FileHistoryPanel(project), "File History", false)
        )
    }
}

/** Bottom dashboards window (VS Code panel analog, next to Terminal/Problems): Observations,
 *  Timeline, and Stats side by side in one three-pane split — all visible at once, dividers
 *  draggable, each pane carrying its name in a header. */
class ObservatoryDashboardsFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val right = com.intellij.ui.OnePixelSplitter(false, 0.55f).apply {
            firstComponent = titled("Timeline", TimelinePanel(project))
            secondComponent = titled("Stats", com.cellobservatory.observatory.ui.stats.StatsPanel(project))
        }
        val split = com.intellij.ui.OnePixelSplitter(false, 0.4f).apply {
            firstComponent = titled("Observations", ObservationsPanel(project))
            secondComponent = right
        }
        toolWindow.contentManager.addContent(
            ContentFactory.getInstance().createContent(split, "", false)
        )
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
