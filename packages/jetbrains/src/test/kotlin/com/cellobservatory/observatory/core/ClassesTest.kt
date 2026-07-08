package com.cellobservatory.observatory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Port-fidelity tests mirroring core's classes.ts unit cases (python indent + brace matching). */
class ClassesTest {

    @Test
    fun `brace languages and python spans, classAt picks the containing class`() {
        val src = "import x;\nexport class Foo {\n  a() { return 1 }\n}\nfunction loose() {}\nclass Bar {\n  b() {}\n}\n"
        val spans = Classes.detectClasses(src)
        assertEquals(2, spans.size)
        assertEquals("Foo", spans[0].name)
        assertEquals(1, spans[0].start)
        assertEquals(3, spans[0].end)
        assertEquals("Bar", spans[1].name)
        assertEquals("Foo", Classes.classAt(spans, 2)?.name)
        assertNull(Classes.classAt(spans, 4)) // loose function -> no class
        assertEquals("Bar", Classes.classAt(spans, 6)?.name)
    }

    @Test
    fun `python body ends before the dedent and allows a trailing comment`() {
        val spans = Classes.detectClasses("class P:  # comment\n    def m(self):\n        pass\nx = 1\n")
        assertEquals(1, spans.size)
        assertEquals("P", spans[0].name)
        assertEquals(2, spans[0].end)
    }

    @Test
    fun `nested python classes - innermost span wins for a nested line`() {
        val src = "class Outer:\n    x = 1\n    class Inner:\n        y = 2\n    z = 3\n"
        val spans = Classes.detectClasses(src)
        assertEquals(2, spans.size)
        val outer = spans.first { it.name == "Outer" }
        val inner = spans.first { it.name == "Inner" }
        assertEquals(0, outer.start)
        assertEquals(4, outer.end)
        assertEquals(2, inner.start)
        assertEquals(3, inner.end)
        assertEquals("Inner", Classes.classAt(spans, 3)?.name)
        assertEquals("Outer", Classes.classAt(spans, 4)?.name)
    }

    @Test
    fun `an unclosed brace class runs to the last line`() {
        val spans = Classes.detectClasses("class Broke {\n  a() {\n  // never closed")
        assertEquals(1, spans.size)
        assertEquals("Broke", spans[0].name)
        assertEquals(2, spans[0].end)
    }
}
