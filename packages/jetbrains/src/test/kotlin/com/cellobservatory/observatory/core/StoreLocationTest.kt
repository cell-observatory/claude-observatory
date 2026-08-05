package com.cellobservatory.observatory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Paths

/**
 * The Kotlin path layer must follow `prefs.storeDir`.
 *
 * It did not: `rootDir()` was `configDir()/claude-observatory` unconditionally, so after a move —
 * made from this plugin's own popup, or from the terminal app, or from VS Code — every DIRECT read
 * here still resolved the abandoned location. Pending badges fell to zero, "Undo all" reported
 * nothing to revert while edits were pending, and a double-clicked edit opened a diff of
 * empty-against-empty, because `readBlob` swallows a missing file. Meanwhile the CLI-backed panels
 * followed the move, so one tool window showed two different truths.
 */
class StoreLocationTest {

    private fun writePrefs(cfg: java.nio.file.Path, json: String) {
        val dir = cfg.resolve("claude-observatory")
        Files.createDirectories(dir)
        Files.writeString(dir.resolve("prefs.json"), json)
    }

    @Test
    fun `with no setting the root is the default beside the config`() {
        val cfg = Files.createTempDirectory("cp-default")
        ClaudePaths.configDirOverride = cfg
        ClaudePaths.forgetRoot()
        assertEquals(cfg.resolve("claude-observatory"), ClaudePaths.rootDir())
    }

    @Test
    fun `a moved store is followed, and the session paths move with it`() {
        val cfg = Files.createTempDirectory("cp-moved")
        val dest = Files.createTempDirectory("cp-dest").resolve("obs")
        ClaudePaths.configDirOverride = cfg
        writePrefs(cfg, """{"storeDir": "${dest.toString().replace("\\", "\\\\")}"}""")
        ClaudePaths.forgetRoot()

        assertEquals(dest, ClaudePaths.rootDir())
        assertEquals(dest.resolve("sess1"), ClaudePaths.storeDir("sess1"))
        assertEquals(dest.resolve("sess1").resolve("log.jsonl"), ClaudePaths.logPath("sess1"))
        // Transcripts are NOT store data — they stay beside the config wherever the store goes.
        assertTrue(ClaudePaths.projectDir("/tmp/x").startsWith(cfg))
    }

    @Test
    fun `a malformed or absent prefs file falls back rather than breaking every read`() {
        val cfg = Files.createTempDirectory("cp-bad")
        ClaudePaths.configDirOverride = cfg
        writePrefs(cfg, "{ not json")
        ClaudePaths.forgetRoot()
        assertEquals(cfg.resolve("claude-observatory"), ClaudePaths.rootDir())

        writePrefs(cfg, """{"storeDir": "   "}""")
        ClaudePaths.forgetRoot()
        assertEquals(cfg.resolve("claude-observatory"), ClaudePaths.rootDir())
    }

    /**
     * Redirecting the seam drops the cached root on its own — the caller must not have to know to say so.
     *
     * Every test above says `forgetRoot()` by hand. The ones that do not — the headless-IDE tests that
     * seed a store and then write into it — were left with a one-second window in which
     * `createDirectories(storeDir(s))` landed under the PREVIOUS test's root while
     * `writeString(logPath(s))` landed under their own, one cache expiry apart. That surfaced as a
     * `NoSuchFileException` in whichever test happened to run second, and passed when run alone, which
     * is the worst shape a failure can take: it reads as flakiness in the test rather than a seam that
     * does not do what its name says.
     */
    @Test
    fun `redirecting the seam drops the cached root, with no forgetRoot by hand`() {
        val a = Files.createTempDirectory("cp-seam-a")
        val b = Files.createTempDirectory("cp-seam-b")
        ClaudePaths.configDirOverride = a
        assertEquals(a.resolve("claude-observatory"), ClaudePaths.rootDir()) // populates the cache
        ClaudePaths.configDirOverride = b // deliberately NO forgetRoot() here
        assertEquals(
            "the seam answered with the previous root, so the cache outlived the redirect",
            b.resolve("claude-observatory"),
            ClaudePaths.rootDir(),
        )
    }

    @Test
    fun `a tilde in the setting is expanded, because that is what a reader types`() {
        val cfg = Files.createTempDirectory("cp-tilde")
        ClaudePaths.configDirOverride = cfg
        writePrefs(cfg, """{"storeDir": "~/obs-store"}""")
        ClaudePaths.forgetRoot()
        assertEquals(Paths.get(System.getProperty("user.home"), "obs-store"), ClaudePaths.rootDir())
    }
}
