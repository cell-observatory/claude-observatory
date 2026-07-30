package com.cellobservatory.observatory.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `editorReviewSurface` is the one switch that decides whether a file with pending edits gets the floating
 * bar, the editor-top banner, both, or neither — read by exactly two consumers through the two derived
 * properties pinned here. Nothing else in the suite would notice a default flipped to `banner`, a spelling
 * renamed out from under the persisted XML, or an unrecognized value falling through to "no chrome at all",
 * and each of those ships an editor with no review controls in it and no error anywhere.
 */
class EditorReviewSurfaceTest {

    private fun surface(value: String) = ObservatorySettings.State().apply { editorReviewSurface = value }

    @Test
    fun `a fresh install gets the floating bar and only the floating bar`() {
        val fresh = ObservatorySettings.State()
        assertEquals(
            "the default the Settings combo resets to and unknown values fall back to",
            ObservatorySettings.FLOATING,
            fresh.editorReviewSurface,
        )
        assertTrue("a fresh install shows the bar", fresh.floatingSurface)
        assertFalse("…and not the banner as well — double chrome for the same verbs", fresh.bannerSurface)
    }

    @Test
    fun `each spelling selects its own chrome`() {
        // Keyed by LITERALS, not by the constants, because these four strings are what claude-observatory.xml
        // carries between runs: renaming a constant's value has to break something here.
        val want = mapOf(
            "floating" to (true to false),
            "banner" to (false to true),
            "both" to (true to true),
            "none" to (false to false),
        )
        for ((value, chrome) in want) {
            val s = surface(value)
            assertEquals("`$value` and the floating bar", chrome.first, s.floatingSurface)
            assertEquals("`$value` and the banner", chrome.second, s.bannerSurface)
        }
        assertEquals(
            "the constants the combo and the two consumers spell it with must BE those four strings",
            want.keys,
            setOf(
                ObservatorySettings.FLOATING,
                ObservatorySettings.BANNER,
                ObservatorySettings.BOTH,
                ObservatorySettings.NONE,
            ),
        )
    }

    @Test
    fun `an unrecognized value reads as the default, never as no chrome at all`() {
        // A hand-edited claude-observatory.xml, a value from a future release, a case-mangled one. Reading
        // any of them as "neither" strips every review control out of the editor with nothing to notice.
        for (junk in listOf("", " ", "Floating", "FLOATING", "bar", "off", "floating ", "none!")) {
            val s = surface(junk)
            assertTrue("`$junk` must still show the bar", s.floatingSurface)
            assertFalse("`$junk` must not also raise the banner", s.bannerSurface)
        }
    }
}
