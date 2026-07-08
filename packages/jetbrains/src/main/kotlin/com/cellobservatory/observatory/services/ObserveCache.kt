package com.cellobservatory.observatory.services

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.ObservePayload
import com.cellobservatory.observatory.model.ObserveParser
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.util.concurrency.AppExecutorUtil
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Cached `observe --json` payload (recap + per-edit reasoning/flags/memory). The CLI call scans
 * the session transcript, so it runs in the background, keyed on (session, log mtime/size); the
 * last good payload keeps rendering while a refresh is in flight.
 */
@Service(Service.Level.PROJECT)
class ObserveCache(private val project: Project) : Disposable {

    @Volatile
    private var payload: ObservePayload? = null

    @Volatile
    private var key: String = ""
    private val running = AtomicBoolean(false)
    private val listeners = CopyOnWriteArrayList<Runnable>()

    fun addListener(l: Runnable) = listeners.add(l)

    /** Latest payload (possibly stale); schedules a background refresh when the store moved. */
    fun payload(): ObservePayload? {
        val session = ObservatoryService.getInstance(project).currentSession() ?: return null
        val k = "$session:${StoreReader.logKey(session)}"
        if (k != key && running.compareAndSet(false, true)) {
            AppExecutorUtil.getAppExecutorService().submit {
                try {
                    val json = ObservatoryCli.observeJson(session, project.basePath)
                    val parsed = json?.let { ObserveParser.parse(it) }
                    if (parsed != null) {
                        payload = parsed
                        key = k
                    }
                } finally {
                    running.set(false)
                }
                ApplicationManager.getApplication().invokeLater {
                    if (!project.isDisposed) listeners.forEach { it.run() }
                }
            }
        }
        return payload
    }

    /** Drop the cache key so the next payload() call re-runs observe (e.g. after analyze/recap). */
    fun invalidate() {
        key = ""
    }

    override fun dispose() {
        listeners.clear()
    }

    companion object {
        fun getInstance(project: Project): ObserveCache = project.getService(ObserveCache::class.java)
    }
}
