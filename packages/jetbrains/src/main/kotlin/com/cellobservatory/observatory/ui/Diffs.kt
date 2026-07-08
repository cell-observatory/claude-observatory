package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.EditRecord
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.project.Project
import java.io.File

/** Before ⟷ after viewer for one edit, from the store's content-addressed blobs. */
object Diffs {
    fun show(project: Project, session: String, rec: EditRecord) {
        val before = StoreReader.readBlob(session, rec.beforeBlob)
        val after = StoreReader.readBlob(session, rec.afterBlob)
        val name = File(rec.file).name
        val type = FileTypeManager.getInstance().getFileTypeByFileName(name) // syntax highlighting per side
        val factory = DiffContentFactory.getInstance()
        val request = SimpleDiffRequest(
            "$name — edit #${rec.id} (before ⟷ after)",
            factory.create(project, before, type),
            factory.create(project, after, type),
            if (rec.beforeBlob == null) "(new file)" else "before",
            if (rec.afterBlob == null) "(deleted)" else "after",
        )
        DiffManager.getInstance().showDiff(project, request)
    }
}
