package com.cellobservatory.observatory.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/** Port-fidelity tests against core's session.ts: cwd mangling, newest-jsonl, parent-dir walk. */
class SessionResolverTest {
    private lateinit var cfg: Path

    @Before
    fun setUp() {
        cfg = Files.createTempDirectory("co-test-cfg")
        ClaudePaths.configDirOverride = cfg
    }

    @After
    fun tearDown() {
        ClaudePaths.configDirOverride = null
        cfg.toFile().deleteRecursively()
    }

    @Test
    fun `mangleCwd replaces every non-alphanumeric char with a dash`() {
        assertEquals("-Users-thayer-Github", ClaudePaths.mangleCwd("/Users/thayer/Github"))
        assertEquals("-a-b-proj-x", ClaudePaths.mangleCwd("/a b/proj-x"))
        // non-ASCII letters mangle char-per-char, same as the TS regex ([^a-zA-Z0-9] -> '-')
        assertEquals("-Users-caf--proj", ClaudePaths.mangleCwd("/Users/café/proj"))
    }

    @Test
    fun `newest jsonl by mtime wins and subdirectories walk up to the project root`() {
        val cwd = "/Users/x/proj"
        val proj = ClaudePaths.projectDir(cwd)
        Files.createDirectories(proj)
        Files.writeString(proj.resolve("old.jsonl"), "{}")
        Files.writeString(proj.resolve("new.jsonl"), "{}")
        proj.resolve("old.jsonl").toFile().setLastModified(1_000_000)
        proj.resolve("new.jsonl").toFile().setLastModified(2_000_000)
        assertEquals("new", SessionResolver.resolveSessionId(cwd))
        assertEquals("new", SessionResolver.resolveSessionId("$cwd/sub/deep")) // ancestor walk
    }

    @Test
    fun `no session anywhere up the tree resolves to null`() {
        assertNull(SessionResolver.resolveSessionId("/definitely/not/a/real/project"))
    }

    @Test
    fun `findTranscript locates the session jsonl via the same parent walk`() {
        val cwd = "/Users/x/proj2"
        val proj = ClaudePaths.projectDir(cwd)
        Files.createDirectories(proj)
        Files.writeString(proj.resolve("sess.jsonl"), "{}")
        assertEquals(proj.resolve("sess.jsonl"), SessionResolver.findTranscript("$cwd/nested", "sess"))
        assertNull(SessionResolver.findTranscript(cwd, "other"))
    }

    // --- stub transcripts must never hijack resolution (port-fidelity with session.ts) ---------

    private fun realTranscript(id: String, cwd: String): String =
        """{"type":"user","sessionId":"$id","cwd":"$cwd","message":{"role":"user","content":"do the thing"}}
          |{"type":"assistant","sessionId":"$id","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}
          |""".trimMargin()

    private fun effortStub(id: String, cwd: String): String =
        """{"type":"user","sessionId":"$id","cwd":"$cwd","message":{"role":"user","content":"<command-name>/effort</command-name>"}}
          |{"type":"user","sessionId":"$id","cwd":"$cwd","message":{"role":"user","content":"<local-command-stdout>Set effort level to xhigh</local-command-stdout>"}}
          |""".trimMargin()

    private fun write(proj: Path, id: String, content: String, mtime: Long): Path {
        val p = proj.resolve("$id.jsonl")
        Files.writeString(p, content)
        p.toFile().setLastModified(mtime)
        return p
    }

    @Test
    fun `command-only stub with cwd never hijacks resolution`() {
        val cwd = "/Users/x/proj3"
        val proj = ClaudePaths.projectDir(cwd)
        Files.createDirectories(proj)
        write(proj, "real-one", realTranscript("real-one", cwd), 1_000_000)
        write(proj, "effort-stub", effortStub("effort-stub", cwd), 2_000_000) // stub is NEWER
        assertEquals("real-one", SessionResolver.resolveSessionId(cwd))
    }

    @Test
    fun `bridge-session stub never hijacks resolution`() {
        val cwd = "/Users/x/proj4"
        val proj = ClaudePaths.projectDir(cwd)
        Files.createDirectories(proj)
        write(proj, "real-one", realTranscript("real-one", cwd), 1_000_000)
        write(proj, "bridge", """{"type":"bridge-session","sessionId":"bridge","lastSequenceNum":0}""" + "\n", 2_000_000)
        assertEquals("real-one", SessionResolver.resolveSessionId(cwd))
    }

    @Test
    fun `all assistant-less transcripts fall back to newest`() {
        val cwd = "/Users/x/proj5"
        val proj = ClaudePaths.projectDir(cwd)
        Files.createDirectories(proj)
        write(proj, "older-stub", effortStub("older-stub", cwd), 1_000_000)
        write(proj, "newer-stub", effortStub("newer-stub", cwd), 2_000_000)
        assertEquals("newer-stub", SessionResolver.resolveSessionId(cwd))
    }

    @Test
    fun `growing transcript flips from skipped to selected once the first assistant record lands`() {
        val cwd = "/Users/x/proj6"
        val proj = ClaudePaths.projectDir(cwd)
        Files.createDirectories(proj)
        write(proj, "real-old", realTranscript("real-old", cwd), 1_000_000)
        val p = write(
            proj, "real-new",
            """{"type":"user","sessionId":"real-new","cwd":"$cwd","message":{"role":"user","content":"fresh prompt"}}""" + "\n",
            2_000_000
        )
        assertEquals("real-old", SessionResolver.resolveSessionId(cwd))
        Files.writeString(
            p,
            Files.readString(p) +
                """{"type":"assistant","sessionId":"real-new","message":{"role":"assistant","content":[{"type":"text","text":"on it"}]}}""" + "\n"
        )
        p.toFile().setLastModified(3_000_000)
        assertEquals("real-new", SessionResolver.resolveSessionId(cwd))
    }

    @Test
    fun `pasted content containing an assistant type marker does not count`() {
        val cwd = "/Users/x/proj7"
        val proj = ClaudePaths.projectDir(cwd)
        Files.createDirectories(proj)
        write(proj, "real-one", realTranscript("real-one", cwd), 1_000_000)
        write(
            proj, "tricky-stub",
            """{"type":"user","sessionId":"tricky-stub","cwd":"$cwd","message":{"role":"user","content":"look: {\"type\":\"assistant\",\"message\":{}}"}}""" + "\n",
            2_000_000
        )
        assertEquals("real-one", SessionResolver.resolveSessionId(cwd))
    }
}
