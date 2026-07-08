package com.cellobservatory.observatory.ui.inline

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.ui.Diffs
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.openapi.editor.DefaultLanguageHighlighterColors
import com.intellij.openapi.editor.EditorCustomElementRenderer
import com.intellij.openapi.editor.Inlay
import com.intellij.openapi.editor.markup.TextAttributes
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.util.ui.UIUtil
import java.awt.Graphics
import java.awt.Rectangle

/**
 * The CodeLens analog: a block inlay above an edit's first line painting
 * "✓ Keep #N   ↩ Undo   ⇄ Diff" in comment-grey. Segment hit-boxes are recorded at paint
 * time; InlineOverlay's mouse listener translates clicks into the segment actions.
 */
class LensRenderer(
    private val project: Project,
    private val session: String,
    private val rec: EditRecord,
) : EditorCustomElementRenderer {

    private class Seg(val text: String, val run: (() -> Unit)?) {
        var x0 = 0
        var x1 = 0
    }

    private val segments = listOf(
        Seg("✓ Keep #${rec.id}") { ReviewOps.keep(project, session, rec.id) },
        Seg("   ", null),
        Seg("↩ Undo") { ReviewOps.undoOrRedo(project, session, rec, redo = false) },
        Seg("   ", null),
        Seg("⇄ Diff") { Diffs.show(project, session, rec) },
    )

    private fun font(inlay: Inlay<*>) =
        UIUtil.getFontWithFallback(inlay.editor.colorsScheme.getFont(com.intellij.openapi.editor.colors.EditorFontType.PLAIN))
            .deriveFont((inlay.editor.colorsScheme.editorFontSize - 2).toFloat())

    override fun calcWidthInPixels(inlay: Inlay<*>): Int {
        val fm = inlay.editor.component.getFontMetrics(font(inlay))
        return segments.sumOf { seg: Seg -> fm.stringWidth(seg.text) } + 16
    }

    override fun calcHeightInPixels(inlay: Inlay<*>): Int = inlay.editor.lineHeight

    override fun paint(inlay: Inlay<*>, g: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
        val editor = inlay.editor
        val f = font(inlay)
        g.font = f
        val fm = g.getFontMetrics(f)
        val grey = editor.colorsScheme.getAttributes(DefaultLanguageHighlighterColors.LINE_COMMENT)?.foregroundColor
            ?: JBColor.GRAY
        g.color = grey
        var x = targetRegion.x + 8 // slight indent so the lens doesn't collide with the gutter edge
        val y = targetRegion.y + fm.ascent + (targetRegion.height - fm.height) / 2
        for (seg in segments) {
            seg.x0 = x - targetRegion.x
            g.drawString(seg.text, x, y)
            x += fm.stringWidth(seg.text)
            seg.x1 = x - targetRegion.x
        }
    }

    /** The action under a click at [xInInlay] pixels from the inlay's left edge, or null. */
    fun actionAt(xInInlay: Int): (() -> Unit)? =
        segments.firstOrNull { it.run != null && xInInlay in it.x0 until it.x1 }?.run
}

/** The dim " ✨ #N" marker after an edit's last line. */
class StarRenderer(private val id: Int) : EditorCustomElementRenderer {
    private fun text() = " ✨ #$id"

    override fun calcWidthInPixels(inlay: Inlay<*>): Int {
        val editor = inlay.editor
        val fm = editor.component.getFontMetrics(editor.colorsScheme.getFont(com.intellij.openapi.editor.colors.EditorFontType.PLAIN))
        return fm.stringWidth(text())
    }

    override fun paint(inlay: Inlay<*>, g: Graphics, targetRegion: Rectangle, textAttributes: TextAttributes) {
        val editor = inlay.editor
        g.font = editor.colorsScheme.getFont(com.intellij.openapi.editor.colors.EditorFontType.PLAIN)
            .deriveFont(java.awt.Font.ITALIC)
        g.color = editor.colorsScheme.getAttributes(DefaultLanguageHighlighterColors.LINE_COMMENT)?.foregroundColor
            ?: JBColor.GRAY
        val fm = g.fontMetrics
        g.drawString(text(), targetRegion.x, targetRegion.y + fm.ascent + (targetRegion.height - fm.height) / 2)
    }
}
