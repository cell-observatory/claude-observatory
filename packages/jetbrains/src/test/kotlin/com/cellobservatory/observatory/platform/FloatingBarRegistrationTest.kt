package com.cellobservatory.observatory.platform

import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The floating review bar reaches an editor through plugin.xml and through nothing else: the platform
 * instantiates the provider from the `editorFloatingToolbarProvider` extension point. Every other test of
 * the bar constructs that provider directly, so deleting the registration — or moving the class without
 * updating the XML — removes the bar from every editor while the whole suite stays green. Same shape as
 * [ToolWindowIdContractTest], which pins the tool-window ids for the same reason.
 */
class FloatingBarRegistrationTest {
    @Test
    fun `plugin xml registers the floating review bar`() {
        val xml = javaClass.getResourceAsStream("/META-INF/plugin.xml")!!.readBytes().decodeToString()
        // The FQCN comes from the class itself, so a package move that leaves the XML behind fails here
        // rather than at runtime, where it is one line in the IDE log and a bar that never appears.
        val fqcn = com.cellobservatory.observatory.ui.editor.ObservatoryFloatingToolbarProvider::class.java.name
        assertTrue(
            "plugin.xml declares no <editorFloatingToolbarProvider> — nothing builds the floating bar",
            xml.contains("<editorFloatingToolbarProvider"),
        )
        // `[^>]*` spans lines (the attribute sits on the next one); only the element's own `>` ends it.
        assertTrue(
            "the <editorFloatingToolbarProvider> in plugin.xml does not name $fqcn",
            Regex("""<editorFloatingToolbarProvider[^>]*\Q$fqcn\E""").containsMatchIn(xml),
        )
    }
}
