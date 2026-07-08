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
}
