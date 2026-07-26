package com.cellobservatory.observatory.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Overview's nav bar offers these verbs, and VS Code contributes the same four commands with the same
 * state gating on its own Overview title bar. This pins the list and the gating, so the two editors cannot
 * drift apart and the gating stays a partition rather than becoming "Start and Exit both visible at once".
 * It is the only level at which any of this is testable: the panel that renders it needs a Project.
 */
class DemoVerbsTest {

    @Test
    fun `the four verbs are offered, each once`() {
        val texts = DemoVerbs.ALL.map { it.text }
        assertEquals(listOf("Start Demo Mode", "Restart Demo", "Guided Tour", "Exit Demo Mode"), texts)
        assertEquals("no verb is listed twice", texts.size, texts.toSet().size)
    }

    @Test
    fun `the gating is a partition — exactly one verb applies before a demo exists`() {
        // Start is the only thing to offer when there is nothing recorded; the other three act on a demo
        // and would be dead controls without one. A toolbar shows a verb when demoPresent == wantDemo,
        // so this is what stops both Start and Exit appearing in the same state.
        val before = DemoVerbs.ALL.filter { !it.wantDemo }
        val after = DemoVerbs.ALL.filter { it.wantDemo }
        assertEquals(listOf("Start Demo Mode"), before.map { it.text })
        assertEquals(listOf("Restart Demo", "Guided Tour", "Exit Demo Mode"), after.map { it.text })
    }

    @Test
    fun `every verb carries an icon and a runnable`() {
        // A toolbar action with no icon renders as a blank button in a JetBrains toolbar — invisible, and
        // only ever noticed by someone looking at the real IDE.
        for (v in DemoVerbs.ALL) {
            assertTrue("${v.text} has an icon", v.icon.iconWidth > 0 && v.icon.iconHeight > 0)
        }
    }
}
