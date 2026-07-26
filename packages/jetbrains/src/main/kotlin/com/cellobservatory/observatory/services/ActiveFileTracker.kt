package com.cellobservatory.observatory.services

import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.FileEditorManagerEvent
import com.intellij.openapi.fileEditor.FileEditorManagerListener
import com.intellij.openapi.project.Project

/**
 * The path of the editor tab in front, kept current so a toolbar's `update()` can read it from a
 * BACKGROUND thread.
 *
 * Why this exists: every action on the review nav bars declared `ActionUpdateThread.EDT` for one reason —
 * `FileEditorManager.selectedFiles`. The platform expands a toolbar's actions on a background thread, so
 * each of those actions forced a hop back to the EDT, one per action, and it waited in line behind
 * whatever the EDT was already doing. The IDE's own log measured it: 1297 complaints, and single
 * toolbars taking 4.8–6.8 SECONDS to expand — six of them on every refresh tick. That is the lag.
 *
 * A listener writes the path on the EDT; readers get a `@Volatile` field. Being one event stale is
 * harmless here — it decides whether a button is visible, and the next tick corrects it — whereas
 * blocking the EDT to be exactly current is what made the IDE feel broken.
 */
@Service(Service.Level.PROJECT)
class ActiveFileTracker(private val project: Project) {

    @Volatile
    private var path: String? = null

    init {
        project.messageBus.connect().subscribe(
            FileEditorManagerListener.FILE_EDITOR_MANAGER,
            object : FileEditorManagerListener {
                override fun selectionChanged(event: FileEditorManagerEvent) {
                    path = event.newFile?.path
                }
            },
        )
    }

    /** Safe from any thread. Seeds itself on first use from the EDT-owned manager when nothing is cached
     *  yet — the listener only fires on a CHANGE, so a panel built after the last tab switch would
     *  otherwise read null forever. */
    fun activePath(): String? {
        path?.let { return it }
        if (!com.intellij.openapi.application.ApplicationManager.getApplication().isDispatchThread) return null
        return FileEditorManager.getInstance(project).selectedFiles.firstOrNull()?.path?.also { path = it }
    }

    companion object {
        fun getInstance(project: Project): ActiveFileTracker = project.service()
    }
}
