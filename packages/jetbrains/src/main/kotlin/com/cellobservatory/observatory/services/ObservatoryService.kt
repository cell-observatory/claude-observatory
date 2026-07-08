package com.cellobservatory.observatory.services

import com.cellobservatory.observatory.core.SessionResolver
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.core.StoreWatcher
import com.cellobservatory.observatory.model.EditRecord
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Project-level hub: resolves the active session for this project's root, caches the folded log
 * on the (mtime,size) key, and fans out refresh events (store watcher → trees, status bar, …).
 */
@Service(Service.Level.PROJECT)
class ObservatoryService(private val project: Project) : Disposable {
    private val listeners = CopyOnWriteArrayList<Runnable>()
    private var cachedLog: List<EditRecord> = emptyList()
    private var cachedKey: String = ""
    private var cachedSession: String? = null
    private val watchListener = Runnable { refresh() }

    init {
        StoreWatcher.instance.addListener(watchListener)
    }

    val workspaceRoot: String? get() = project.basePath

    fun currentSession(): String? {
        val root = workspaceRoot ?: return null
        return SessionResolver.resolveSessionId(root).also { cachedSession = it }
    }

    /** Folded log for the current session, cached on the log file's (mtime,size). */
    fun log(): List<EditRecord> {
        val session = currentSession() ?: return emptyList()
        val key = "$session:${StoreReader.logKey(session)}"
        if (key != cachedKey) {
            cachedLog = StoreReader.readLog(session)
            cachedKey = key
        }
        return cachedLog
    }

    data class Counts(val pending: Int, val kept: Int, val undone: Int, val oldestPendingTs: Long?)

    fun counts(): Counts {
        val log = log()
        return Counts(
            pending = log.count { it.pending },
            kept = log.count { it.kept },
            undone = log.count { it.undone },
            oldestPendingTs = log.filter { it.pending }.minOfOrNull { it.ts },
        )
    }

    fun addListener(l: Runnable) = listeners.add(l)
    fun removeListener(l: Runnable) = listeners.remove(l)

    /** Invalidate caches and re-render every registered surface. Call on the EDT. */
    fun refresh() {
        cachedKey = "" // force re-read
        listeners.forEach { it.run() }
    }

    override fun dispose() {
        StoreWatcher.instance.removeListener(watchListener)
    }

    companion object {
        fun getInstance(project: Project): ObservatoryService = project.getService(ObservatoryService::class.java)
    }
}

/** Startup: touch the project service so the watcher is armed even before the tool window opens. */
class ObservatoryStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        ObservatoryService.getInstance(project)
    }
}
