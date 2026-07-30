package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.ColumnLayout
import com.cellobservatory.observatory.settings.ObservatorySettings
import com.intellij.icons.AllIcons
import com.intellij.ui.OnePixelSplitter
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.Font
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.ComponentAdapter
import java.awt.event.ComponentEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * A group of nav members drawn as side-by-side columns: each with its own name, badge and fold control,
 * a draggable divider between neighbours, and remembered widths.
 *
 * ONE renderer, both grouped surfaces — the Overview's nav groups and the Timeline's Prompts ·
 * Observations · Actions. Everything it decides comes from [ColumnLayout]; this class only paints the
 * decision and writes the reader's drags back.
 *
 * Three behaviours are load-bearing, and each exists because its absence is a trap:
 *  · A folded column becomes a RAIL that still carries its name and badge and reopens on a click. A
 *    column that vanishes with no affordance is a state the reader cannot even describe, let alone undo.
 *  · The LAST column showing content refuses to fold ([ColumnLayout.collapse]), so a group is never an
 *    empty pane.
 *  · A drag is stored only while both sides of that divider show content. Folding pins the divider hard
 *    to the rail so the freed pixels go to the readable columns — and because the stored value is left
 *    alone, reopening restores the width the reader set rather than an equal share.
 *
 * @param group the key its remembered widths are stored under (see [ColumnLayout.dividerKey])
 * @param members every member this group can show, in shipped order — including ones not mounted yet
 * @param defaultProportion the shipped divider proportions, by divider index
 */
class ColumnGroupPane(
    private val group: String,
    private val members: List<String>,
    private val title: (String) -> String,
    private val tip: (String) -> String?,
    private val defaultProportion: (Int) -> Float = { 0.5f },
    /** Called after a fold or a reopen, so the host can re-write badges that live on the headers. */
    private val onFoldChange: () -> Unit = {},
) : JPanel(BorderLayout()) {

    private val cfg get() = ObservatorySettings.instance.state

    /** Each member's content, once its host has mounted it. Absent = not present (the Overview's
     *  Processes column, before the CLI has answered for it). */
    private val panes = HashMap<String, JComponent>()

    /** Each member's header label — where its name, badge and tooltip live. Handed to the host so badge
     *  writes keep going to one place whether the member is a tab or a column. */
    private val headers = HashMap<String, JBLabel>()

    /** The rail label of a folded member, so its badge follows it down there too. */
    private val railLabels = HashMap<String, VerticalLabel>()

    private var stacked = false

    init {
        // A width change can cross the point where side-by-side stops fitting the content floor; below it
        // the columns stack rather than shrink (this product never ellipsizes content text).
        addComponentListener(object : ComponentAdapter() {
            override fun componentResized(e: ComponentEvent) {
                val want = ColumnLayout.mustStack(present(), collapsed(), e.component.width)
                if (want != stacked) { stacked = want; rebuild() }
            }
        })
    }

    /** Mount (or replace) a member's content. Members arrive in any order and some arrive late. */
    fun mount(member: String, pane: JComponent) {
        panes[member] = pane
        rebuild()
    }

    /**
     * Hand every mounted column back and hold nothing.
     *
     * Grouped mode is off, and the same panel objects are about to be adopted by a tab strip. Without
     * this, a later [rebuild] — a resize tick, a fold — would silently re-parent them out of the tabs the
     * reader is looking at.
     */
    fun detach() {
        panes.clear()
        railLabels.clear()
        removeAll()
        revalidate()
        repaint()
    }

    /** A member's header label, created on demand so a host can badge a column it has not mounted yet. */
    fun header(member: String): JBLabel = headers.getOrPut(member) {
        JBLabel(title(member)).apply {
            font = JBUI.Fonts.label().deriveFont(Font.BOLD)
            foreground = UIUtil.getContextHelpForeground()
            toolTipText = tip(member)
        }
    }

    /** Run [onClick] when the reader clicks this member's header (not its fold control).
     *
     *  Attached to the member's cached header label, ONCE — a rebuild reuses that same label, so hooking it
     *  up while building a column would stack another listener on every repaint. */
    fun onHeaderClick(member: String, onClick: () -> Unit) {
        header(member).addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) = onClick()
        })
    }

    /** The members actually mounted, in shipped order. */
    private fun present(): List<String> = members.filter { panes.containsKey(it) }

    private fun collapsed(): Set<String> = cfg.collapsedColumns.toSet()

    private fun setCollapsed(next: Set<String>) {
        // Only this group's members are rewritten — the setting is shared by every group in both windows.
        val others = cfg.collapsedColumns.filter { it !in members }
        cfg.collapsedColumns = (others + next.filter { it in members }).toMutableList()
    }

    private fun storedProportion(index: Int): Float =
        cfg.columnSplits[ColumnLayout.dividerKey(group, index)] ?: defaultProportion(index)

    private fun storeProportion(index: Int, p: Float) {
        cfg.columnSplits[ColumnLayout.dividerKey(group, index)] = p
    }

    /** Fold a column away, or refuse when it is the last one showing content. Internal, not private: the
     *  header control below is the only production caller, and the tests drive the same entry point rather
     *  than synthesizing mouse events at a label. */
    internal fun foldColumn(member: String) {
        val before = collapsed()
        val after = ColumnLayout.collapse(present(), before, member)
        if (after == before) return // the group's last readable column — see ColumnLayout.collapse
        setCollapsed(after)
        rebuild()
        onFoldChange()
    }

    /** Bring [member] back if it is folded. "Show me Observations" — from the guided tour, or from any
     *  caller that raises a surface — has to mean showing it, not pointing at the rail it folded into. */
    fun ensureShown(member: String) {
        if (member in collapsed()) unfoldColumn(member)
    }

    internal fun unfoldColumn(member: String) {
        setCollapsed(ColumnLayout.expand(collapsed(), member))
        rebuild()
        onFoldChange()
    }

    /** Rebuild the column chain. Cheap and total: a fold, a mount or an orientation flip all take it. */
    fun rebuild() {
        val present = present()
        removeAll()
        if (present.isEmpty()) { revalidate(); repaint(); return }
        val collapsed = collapsed()
        // Right to left, so divider i always separates present[0..i] from present[i+1..] — the index the
        // stored proportion is keyed by, and the one a late-arriving member appends to rather than shifts.
        var chain: JComponent = columnFor(present.last(), collapsed)
        for (i in present.size - 2 downTo 0) {
            val left = present.take(i + 1)
            val right = present.drop(i + 1)
            val leftComp = columnFor(present[i], collapsed)
            val rightComp = chain
            chain = DoubleClickSplitter(stacked, ColumnLayout.dividerProportion(storedProportion(i), left, right, collapsed)).apply {
                firstComponent = leftComp
                secondComponent = rightComp
                // The minimum sizes below are the content floor and the rail width; honouring them is what
                // keeps a rail exactly a rail and a column readable.
                setHonorComponentsMinimumSize(true)
                // Record only a drag the reader could actually make: while one side is folded the
                // proportion is pinned to it, and storing that would overwrite the width they set.
                addPropertyChangeListener("proportion") {
                    if (left.any { m -> m !in collapsed } && right.any { m -> m !in collapsed }) {
                        storeProportion(i, proportion)
                    }
                }
                // Double-click a divider to put this pair back to even — a way out of a bad drag that
                // costs nothing to offer.
                onDividerDoubleClick = {
                    storeProportion(i, defaultProportion(i))
                    proportion = defaultProportion(i)
                }
            }
        }
        add(chain, BorderLayout.CENTER)
        revalidate()
        repaint()
    }

    /** One column: its content under a header, or a rail when folded. */
    private fun columnFor(member: String, collapsed: Set<String>): JComponent =
        if (member in collapsed) rail(member) else column(member)

    private fun column(member: String): JComponent {
        val head = header(member)
        val bar = JPanel(BorderLayout()).apply {
            isOpaque = false
            border = JBUI.Borders.empty(3, 6, 2, 2)
            add(head, BorderLayout.CENTER)
            add(foldButton(member), BorderLayout.EAST)
        }
        return object : JPanel(BorderLayout()) {
            // The content floor, declared where the splitter can honour it.
            override fun getMinimumSize() = Dimension(JBUI.scale(ColumnLayout.MIN_COLUMN_PX), 0)
        }.apply {
            add(bar, BorderLayout.NORTH)
            panes[member]?.let { add(it, BorderLayout.CENTER) }
        }
    }

    /** A folded column: a rail carrying the member's own name and badge, and reopening on a click. */
    private fun rail(member: String): JComponent {
        val label = VerticalLabel(header(member).text).also { railLabels[member] = it }
        val icon = JBLabel(AllIcons.Actions.Expandall).apply {
            border = JBUI.Borders.empty(3, 2, 2, 2)
        }
        return object : JPanel(BorderLayout()) {
            override fun getMinimumSize() = Dimension(JBUI.scale(ColumnLayout.RAIL_PX), 0)
            override fun getPreferredSize() = Dimension(JBUI.scale(ColumnLayout.RAIL_PX), 0)
            override fun getMaximumSize() = Dimension(JBUI.scale(ColumnLayout.RAIL_PX), Int.MAX_VALUE)
        }.apply {
            toolTipText = "${header(member).text} — folded away. Click to bring this column back."
            add(icon, BorderLayout.NORTH)
            add(label, BorderLayout.CENTER)
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) = unfoldColumn(member)
            })
            label.addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) = unfoldColumn(member)
            })
        }
    }

    private fun foldButton(member: String): JComponent = JBLabel(AllIcons.Actions.Collapseall).apply {
        toolTipText = "Fold this column away — it stays as a rail you can click to bring it back"
        border = JBUI.Borders.empty(0, 4)
        addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) = foldColumn(member)
        })
    }

    /** Keep the rails' text in step with a badge written to the header (grouped mode re-badges on every
     *  payload, and a rail showing a stale count is worse than one showing none). */
    fun syncRailText(member: String) {
        railLabels[member]?.let { it.text = header(member).text; it.revalidate(); it.repaint() }
    }

    /**
     * A splitter whose divider answers a double-click.
     *
     * The platform exposes no getter for the divider, and `createDivider()` runs inside the SUPERCLASS
     * constructor — before any subclass field is assigned — so the handler is read at click time from a
     * field the caller fills in afterwards, never captured during construction.
     */
    private class DoubleClickSplitter(vertical: Boolean, proportion: Float) : OnePixelSplitter(vertical, proportion) {
        var onDividerDoubleClick: (() -> Unit)? = null
        override fun createDivider(): com.intellij.openapi.ui.Divider = super.createDivider().apply {
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    if (e.clickCount == 2) onDividerDoubleClick?.invoke()
                }
            })
        }
    }

}

/**
 * The member's own name, drawn down a folded column's rail. Rotated rather than clipped: this product
 * never ellipsizes a name the reader is meant to click. File-level (not nested) so a test can name it.
 */
internal class VerticalLabel(text: String) : javax.swing.JComponent() {
    var text: String = text
        set(value) { field = value; revalidate(); repaint() }

    init {
        font = JBUI.Fonts.label()
        foreground = UIUtil.getContextHelpForeground()
    }

    override fun getPreferredSize(): Dimension {
        val fm = getFontMetrics(font)
        return Dimension(fm.height, fm.stringWidth(text) + JBUI.scale(8))
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g.create() as Graphics2D
        try {
            g2.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_ON)
            g2.font = font
            g2.color = foreground
            val fm = g2.fontMetrics
            // Top-down, reading with the head tilted right — the direction every IDE draws a side tab.
            g2.rotate(Math.PI / 2)
            g2.drawString(text, JBUI.scale(4), -(width - fm.ascent) / 2)
        } finally {
            g2.dispose()
        }
    }
}
