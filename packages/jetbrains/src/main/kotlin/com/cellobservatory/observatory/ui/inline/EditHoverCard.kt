package com.cellobservatory.observatory.ui.inline

import com.cellobservatory.observatory.model.EditRecord
import com.cellobservatory.observatory.services.ObserveCache
import com.cellobservatory.observatory.ui.Diffs
import com.cellobservatory.observatory.ui.ReviewOps
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopup
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.awt.RelativePoint
import com.intellij.ui.components.ActionLink
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Point
import java.awt.Rectangle
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JEditorPane
import javax.swing.JPanel

/**
 * The hover card for one edit (VS Code hover-card analog): title, Claude's FULL reasoning
 * (multi-line, wrapped — never truncated), and Keep/Undo/Diff/Chat links. Shown on hover over
 * the ✨ marker and from the gutter/star click paths; auto-dismisses when the mouse leaves the
 * card and its anchor.
 */
internal object EditHoverCard {
    private var popup: JBPopup? = null
    private var forId = -1

    fun show(project: Project, session: String, rec: EditRecord, anchorScreen: Rectangle) {
        if (popup?.isVisible == true && forId == rec.id) return
        hide()

        val panel = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(10, 12)
        }
        panel.add(JBLabel("Claude edit #${rec.id} · ${rec.tool}").apply {
            font = JBUI.Fonts.label().deriveFont(Font.BOLD)
            alignmentX = 0f
        })
        val reasoning = ObserveCache.getInstance(project).payload()?.edits
            ?.find { it.id == rec.id }?.reasoning?.trim()
        if (!reasoning.isNullOrEmpty()) {
            val esc = reasoning
                .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\n", "<br>")
            panel.add(Box.createVerticalStrut(JBUI.scale(6)))
            panel.add(JEditorPane(
                "text/html",
                "<html><body style='width:${JBUI.scale(360)}px'>💭 $esc</body></html>",
            ).apply {
                isEditable = false
                isOpaque = false
                font = JBUI.Fonts.label()
                alignmentX = 0f
            })
        }
        val links = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(14), 0)).apply {
            isOpaque = false
            alignmentX = 0f
        }
        fun link(text: String, run: () -> Unit) = ActionLink(text) { hide(); run() }
        links.add(link("✓ Keep") { ReviewOps.keep(project, session, rec.id) })
        links.add(link("↩ Undo") { ReviewOps.undoOrRedo(project, session, rec, redo = false) })
        links.add(link("⇄ Diff") { Diffs.show(project, session, rec) })
        links.add(link("💬 Chat") { ReviewOps.chatAbout(project, session, rec.id) })
        links.maximumSize = links.preferredSize
        panel.add(Box.createVerticalStrut(JBUI.scale(8)))
        panel.add(links)

        val p = JBPopupFactory.getInstance().createComponentPopupBuilder(panel, null)
            .setRequestFocus(false)
            .setCancelOnClickOutside(true)
            .setCancelOnMouseOutCallback { me ->
                // true = "mouse is out" → cancel. Stay open over the card (with a small margin)
                // and over the anchor (the ✨ marker), so the mouse can travel into the card.
                val loc = me.locationOnScreen
                val content = popup?.content
                val overCard = content != null && content.isShowing &&
                    Rectangle(content.locationOnScreen, content.size)
                        .apply { grow(JBUI.scale(8), JBUI.scale(8)) }.contains(loc)
                val overAnchor = Rectangle(anchorScreen)
                    .apply { grow(JBUI.scale(6), JBUI.scale(6)) }.contains(loc)
                !(overCard || overAnchor)
            }
            .createPopup()
        popup = p
        forId = rec.id
        p.show(RelativePoint.fromScreen(Point(anchorScreen.x, anchorScreen.y + anchorScreen.height + JBUI.scale(2))))
    }

    fun hide() {
        popup?.cancel()
        popup = null
        forId = -1
    }
}
