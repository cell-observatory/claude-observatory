package com.cellobservatory.observatory.ui

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory

/** Sidebar tool window: Edits (open-at-edit) + Diffs (before⟷after) tabs over the same store. */
class ObservatoryToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val factory = ContentFactory.getInstance()
        toolWindow.contentManager.addContent(
            factory.createContent(EditsTreePanel(project, EditsTreePanel.Mode.EDITS), "Edits", false)
        )
        toolWindow.contentManager.addContent(
            factory.createContent(EditsTreePanel(project, EditsTreePanel.Mode.DIFFS), "Diffs", false)
        )
    }
}
