package com.cellobservatory.observatory.ui.tour

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory

/**
 * The guided tour's window, DECLARED in plugin.xml rather than registered at runtime.
 *
 * It used to call `ToolWindowManager.registerToolWindow(...)`, which the JetBrains Plugin Verifier flags
 * as an override-only API violation: that method is meant to be implemented by the platform, not invoked
 * by a plugin, and calling it is unsupported in a way that can break on any IDE update. Declaring the
 * window and flipping `isAvailable` is the supported equivalent, and it also means the window's id,
 * anchor and stripe title live beside the other two rather than in Kotlin.
 *
 * It starts unavailable: there is nothing to show until a tour runs, and an empty stripe button that
 * does nothing is worse than no stripe button.
 */
class TourToolWindowFactory : ToolWindowFactory, DumbAware {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        TourController.getInstance(project).fillToolWindow(toolWindow)
    }

    /** Hidden until a tour asks for it (see TourController.openWindow). */
    override fun shouldBeAvailable(project: Project): Boolean = TourController.getInstance(project).running
}
