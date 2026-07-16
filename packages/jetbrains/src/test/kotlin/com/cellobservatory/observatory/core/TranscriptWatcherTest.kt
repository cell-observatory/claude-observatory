package com.cellobservatory.observatory.core

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * Tests for the TranscriptWatcher's pure helpers — the bounded per-directory set it registers nio
 * WatchKeys on, and the mtime+size fold that drives the 2s poll fallback. These are the correctness
 * core of the "live window updates on transcript growth, not only on edits" fix (§8), verified without
 * an IDE Application. (The threading/watch loop needs a running platform and is out of scope here.)
 */
class TranscriptWatcherTest {
    private lateinit var cfg: Path

    @Before
    fun setUp() {
        cfg = Files.createTempDirectory("co-tw-cfg")
        ClaudePaths.configDirOverride = cfg
    }

    @After
    fun tearDown() {
        ClaudePaths.configDirOverride = null
        cfg.toFile().deleteRecursively()
    }

    /** A `<mangled cwd>` project dir with one session transcript + one subagent transcript. */
    private fun makeProject(cwd: String, session: String): Path {
        val proj = ClaudePaths.projectDir(cwd)
        Files.createDirectories(proj)
        Files.writeString(proj.resolve("$session.jsonl"), "{}\n")
        val sub = proj.resolve(session).resolve("subagents")
        Files.createDirectories(sub)
        Files.writeString(sub.resolve("agent-a1.jsonl"), "{}\n")
        return proj
    }

    @Test
    fun `projectDirsFor mangles cwds, keeps only existing dirs, and dedupes`() {
        val proj = makeProject("/Users/x/proj", "s1")
        val dirs = TranscriptWatcher.projectDirsFor(
            listOf("/Users/x/proj", "/Users/x/proj", "/Users/x/does-not-exist"),
        )
        assertEquals(listOf(proj), dirs) // deduped, and the missing worktree is dropped (not watched)
    }

    @Test
    fun `watchDirsFor registers the project dir, each session dir, and each subagents subdir`() {
        val proj = makeProject("/Users/x/proj2", "s2")
        val dirs = TranscriptWatcher.watchDirsFor(listOf(proj))
        // The project dir itself — catches a NEW <session>.jsonl and a NEW <session>/ dir on ENTRY_CREATE.
        assertTrue(dirs.contains(proj))
        // The session dir — catches a newly-created subagents/ subdir on ENTRY_CREATE.
        assertTrue(dirs.contains(proj.resolve("s2")))
        // The subagents subdir — catches agent-*.jsonl growth.
        assertTrue(dirs.contains(proj.resolve("s2").resolve("subagents")))
        // Bounded: exactly those three dirs for a single-session project, nothing else.
        assertEquals(3, dirs.size)
    }

    @Test
    fun `transcriptStamp changes on transcript append and on a new subagent transcript`() {
        val proj = makeProject("/Users/x/proj3", "s3")
        val base = TranscriptWatcher.transcriptStamp(listOf(proj))

        // Appending to the main session transcript (a read/bash/spawn/todo line) must move the stamp.
        Files.writeString(
            proj.resolve("s3.jsonl"),
            "{\"type\":\"user\"}\n",
            java.nio.file.StandardOpenOption.APPEND,
        )
        val afterAppend = TranscriptWatcher.transcriptStamp(listOf(proj))
        assertNotEquals("append to a transcript must change the poll stamp", base, afterAppend)

        // A brand-new subagent transcript (a spawn) must also move the stamp.
        Files.writeString(proj.resolve("s3").resolve("subagents").resolve("agent-a2.jsonl"), "{}\n")
        val afterSpawn = TranscriptWatcher.transcriptStamp(listOf(proj))
        assertNotEquals("a new subagent transcript must change the poll stamp", afterAppend, afterSpawn)
    }

    @Test
    fun `transcriptStamp ignores non-jsonl files and empty dir sets`() {
        val proj = makeProject("/Users/x/proj4", "s4")
        Files.writeString(proj.resolve("notes.txt"), "not a transcript")
        val withTxt = TranscriptWatcher.transcriptStamp(listOf(proj))
        Files.writeString(proj.resolve("notes.txt"), "not a transcript, edited longer")
        assertEquals("a non-.jsonl file must not affect the stamp", withTxt, TranscriptWatcher.transcriptStamp(listOf(proj)))
        // An empty / non-existent set is a harmless zero (no watch, no crash).
        assertEquals(0L, TranscriptWatcher.transcriptStamp(emptyList()))
        assertFalse(TranscriptWatcher.watchDirsFor(emptyList()).iterator().hasNext())
    }
}
