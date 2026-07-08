package com.cellobservatory.observatory.core

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.logger
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardWatchEventKinds.ENTRY_CREATE
import java.nio.file.StandardWatchEventKinds.ENTRY_DELETE
import java.nio.file.StandardWatchEventKinds.ENTRY_MODIFY
import java.nio.file.WatchService
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import kotlin.io.path.exists
import kotlin.io.path.isDirectory
import kotlin.io.path.listDirectoryEntries

/**
 * Watches <configDir>/claude-observatory/<any session>/log.jsonl with a plain nio WatchService —
 * the store lives OUTSIDE any project, so VFS watch roots are the wrong tool. Captures land in
 * PreToolUse+PostToolUse bursts, so events are debounced 150ms (same as the VS Code extension).
 * App-level service; project services register listeners and are notified on the EDT.
 */
@Service
class StoreWatcher : Disposable {
    private val log = logger<StoreWatcher>()
    private val listeners = CopyOnWriteArrayList<Runnable>()
    private val debouncer = ScheduledThreadPoolExecutor(1) { r -> Thread(r, "claude-observatory-debounce").apply { isDaemon = true } }
    private var pending: ScheduledFuture<*>? = null

    @Volatile
    private var watcher: WatchService? = null

    fun addListener(l: Runnable) {
        listeners.add(l)
        ensureStarted()
    }

    fun removeListener(l: Runnable) = listeners.remove(l)

    @Synchronized
    private fun ensureStarted() {
        if (watcher != null) return
        val root = ClaudePaths.rootDir()
        try {
            Files.createDirectories(root) // watch works even before the first capture
            val ws = FileSystems.getDefault().newWatchService()
            watcher = ws
            register(ws, root)
            root.listDirectoryEntries().filter { it.isDirectory() }.forEach { register(ws, it) }
            Thread({ loop(ws, root) }, "claude-observatory-watch").apply { isDaemon = true }.start()
        } catch (e: Exception) {
            log.warn("store watch unavailable (${e.message}) — falling back to refresh-on-focus only")
        }
    }

    private fun register(ws: WatchService, dir: Path) {
        try {
            dir.register(ws, ENTRY_CREATE, ENTRY_MODIFY, ENTRY_DELETE)
        } catch (_: Exception) {
            /* dir vanished between listing and registration */
        }
    }

    private fun loop(ws: WatchService, root: Path) {
        while (true) {
            val key = try {
                ws.take()
            } catch (_: Exception) {
                return // watcher closed on dispose
            }
            var relevant = false
            for (ev in key.pollEvents()) {
                val name = (ev.context() as? Path)?.toString() ?: continue
                val parent = key.watchable() as? Path ?: continue
                // New session dir under the root → start watching it for its log.jsonl.
                if (parent == root) {
                    val child = root.resolve(name)
                    if (child.isDirectory()) register(ws, child)
                    relevant = true // a new session's first capture must refresh too
                } else if (name == "log.jsonl") {
                    relevant = true
                }
            }
            key.reset()
            if (relevant) debounceNotify()
        }
    }

    private fun debounceNotify() {
        pending?.cancel(false)
        pending = debouncer.schedule({
            ApplicationManager.getApplication().invokeLater {
                listeners.forEach { it.run() }
            }
        }, 150, TimeUnit.MILLISECONDS)
    }

    override fun dispose() {
        try {
            watcher?.close()
        } catch (_: Exception) {
        }
        debouncer.shutdownNow()
    }

    companion object {
        val instance: StoreWatcher
            get() = ApplicationManager.getApplication().getService(StoreWatcher::class.java)
    }
}
