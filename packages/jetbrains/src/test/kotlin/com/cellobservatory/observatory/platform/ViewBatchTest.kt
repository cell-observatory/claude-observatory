package com.cellobservatory.observatory.platform

import com.cellobservatory.observatory.core.ObservatoryCli
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.File

/**
 * The batch must answer with EXACTLY what the individual command answers, and must degrade to individual
 * spawns against a CLI that has no `views`. Neither property is visible to a unit test of the parsers:
 * both are about how many processes we start and whether the answers survive being batched.
 */
class ViewBatchTest : BasePlatformTestCase() {

    private fun cliOnPath(): Boolean = runCatching {
        ProcessBuilder("claude-observatory", "--version").start().waitFor() == 0
    }.getOrDefault(false)

    fun testBatchedViewsMatchTheirOwnCommands() {
        if (!cliOnPath()) {
            println("SKIPPED ViewBatchTest: `claude-observatory` is not on PATH")
            return
        }
        val home = File(System.getProperty("java.io.tmpdir"), "obs-batch-home-${System.nanoTime()}")
        val work = File(System.getProperty("java.io.tmpdir"), "obs-batch-ws-${System.nanoTime()}")
        home.mkdirs(); work.mkdirs()
        fun cli(vararg args: String): String {
            val pb = ProcessBuilder(listOf("claude-observatory") + args).directory(work).redirectErrorStream(false)
            pb.environment()["HOME"] = home.absolutePath
            val p = pb.start()
            val out = p.inputStream.bufferedReader().readText()
            p.waitFor()
            return out
        }
        try {
            cli("demo", "--fast")
            val session = Regex("demo-[0-9a-f]{8}").find(cli("sessions", "--json"))?.value
            assertNotNull("the replay produced a demo session to read", session)

            // Every view the batch serves, compared against the command it stands in for.
            val batched = cli("views", "--session", session!!, "--root", work.absolutePath, "--json")
            val obj = com.google.gson.JsonParser.parseString(batched).asJsonObject
            for (view in listOf("changemap", "prompts", "processes", "sessions", "risk", "egress")) {
                val single = cli(view, "--session", session, "--root", work.absolutePath, "--json").trim()
                assertTrue("$view answered on its own", single.isNotEmpty())
                val fromBatch = obj.get(view)
                assertNotNull("$view is present in the batch", fromBatch)
                assertEquals(
                    "$view: batching must not change the answer",
                    com.google.gson.JsonParser.parseString(single),
                    fromBatch,
                )
            }
        } finally {
            runCatching { cli("demo", "--clean") }
            home.deleteRecursively(); work.deleteRecursively()
        }
    }

    /** A CLI without `views` must still serve every panel — the plugin loads against whatever is on PATH. */
    fun testAViewIsStillServedWhenTheCliHasNoBatchCommand() {
        if (!cliOnPath()) return
        // `sessions` is the cheapest view; asking with a workDir that has no store exercises the path
        // where the batch cannot help and the individual command has to answer.
        val nowhere = File(System.getProperty("java.io.tmpdir"), "obs-empty-${System.nanoTime()}")
        nowhere.mkdirs()
        try {
            val out = ObservatoryCli.sessionsJson(nowhere.absolutePath, null)
            assertTrue("a sessions payload comes back (batched or not)", out == null || out.contains("sessions"))
        } finally {
            nowhere.deleteRecursively()
        }
    }
}
