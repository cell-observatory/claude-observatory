package com.cellobservatory.observatory.platform

import com.intellij.openapi.actionSystem.ActionToolbar
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.impl.ActionToolbarImpl
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.awt.Container
import javax.swing.JComponent

/**
 * Boots a REAL (headless) IntelliJ application and project, builds the plugin's panels, and asserts the
 * action-system contracts that only a live IDE otherwise reveals.
 *
 * This exists because of a defect no other test in this repo could have caught: every toolbar on the
 * Overview was bound to `targetComponent = fleetTree`, a component that lives inside ONE nav tab. The
 * platform refuses to perform an action whose toolbar target is not showing, so with any other tab
 * selected — Sessions is the default — every button on that panel silently did nothing. It compiled, the
 * unit tests passed, CI was green, and the only evidence was a line in the IDE's own log.
 */
class ToolbarContractTest : BasePlatformTestCase() {

    private fun toolbarsIn(root: Container): List<ActionToolbarImpl> {
        val out = mutableListOf<ActionToolbarImpl>()
        fun walk(c: Container) {
            for (child in c.components) {
                if (child is ActionToolbarImpl) out += child
                if (child is Container) walk(child)
            }
        }
        walk(root)
        return out
    }

    /**
     * A toolbar's target component must not be something that can stop showing while the toolbar itself
     * is still on screen — that is the exact shape of the Overview bug. Binding to the panel that OWNS
     * the toolbar is the safe form: it is showing whenever its own buttons are.
     */
    fun testOverviewToolbarsTargetAComponentThatIsShowingWheneverTheyAre() {
        val panel = com.cellobservatory.observatory.ui.ChangeMapPanel(project)
        val toolbars = toolbarsIn(panel)
        assertTrue("the Overview builds toolbars to check", toolbars.isNotEmpty())
        for (tb in toolbars) {
            val target = tb.targetComponent
            assertNotNull("a toolbar with no target component takes its context from focus, which is worse", target)
            assertTrue(
                "toolbar target must be the owning panel (or an ancestor of it), never a child of one tab: was ${target!!.javaClass.name}",
                target === panel || isAncestor(target, panel),
            )
        }
    }

    private fun isAncestor(maybeAncestor: JComponent, of: Container): Boolean {
        var c: Container? = of
        while (c != null) {
            if (c === maybeAncestor) return true
            c = c.parent
        }
        return false
    }

    /**
     * No toolbar action may declare `ActionUpdateThread.EDT`.
     *
     * The platform expands a toolbar on a background thread; an EDT-bound action makes it hop back, once
     * per action, queued behind whatever the EDT is already doing. The user's own IDE log measured the
     * result: 1297 complaints, and single toolbars taking 4.8–6.8 SECONDS to expand — six of them on
     * every refresh tick. Nothing in a build or a unit test can see that; only this can.
     */
    fun testNoToolbarActionForcesAHopToTheEventDispatchThread() {
        val panels = listOf<java.awt.Container>(
            com.cellobservatory.observatory.ui.ChangeMapPanel(project),
            com.cellobservatory.observatory.ui.PromptsPanel(project),
        )
        val offenders = mutableListOf<String>()
        for (p in panels) for (tb in toolbarsIn(p)) for (a in tb.actionGroup.getChildren(null)) {
            if (a.actionUpdateThread == com.intellij.openapi.actionSystem.ActionUpdateThread.EDT) {
                offenders += a.javaClass.name
            }
        }
        assertEquals("these actions drag toolbar expansion onto the EDT: $offenders", 0, offenders.size)
    }

    /** Every action on those toolbars must survive `update()` without throwing. An exception there kills
     *  the whole toolbar's repaint, taking unrelated buttons with it. */
    fun testEveryOverviewActionSurvivesUpdate() {
        val panel = com.cellobservatory.observatory.ui.ChangeMapPanel(project)
        val actions = mutableListOf<AnAction>()
        for (tb in toolbarsIn(panel)) actions += tb.actionGroup.getChildren(null).toList()
        assertTrue("there are actions to exercise", actions.isNotEmpty())
        val ctx = com.intellij.openapi.actionSystem.impl.SimpleDataContext.getProjectContext(project)
        for (a in actions) {
            val e = com.intellij.openapi.actionSystem.AnActionEvent.createFromDataContext(
                ActionToolbar.ACTION_TOOLBAR_PROPERTY_KEY.toString(), null, ctx
            )
            try {
                a.update(e)
            } catch (t: Throwable) {
                fail("${a.javaClass.name}.update() threw ${t.javaClass.simpleName}: ${t.message}")
            }
        }
    }
}
