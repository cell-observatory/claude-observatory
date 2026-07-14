package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.core.StoreReader
import com.cellobservatory.observatory.model.ChangeMap
import com.cellobservatory.observatory.model.ChangeMapFile
import com.cellobservatory.observatory.model.ChangeMapModule
import com.cellobservatory.observatory.model.ChangeMapParser
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.ToggleAction
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.SimpleToolWindowPanel
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.BoxLayout
import javax.swing.DefaultListModel
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.JToggleButton
import javax.swing.ListCellRenderer

// The product's review palette — same hexes the VS Code webview reads from --vscode-charts-*, so the
// two editors colour a status identically. (StatsPanel keeps its own file-private copies.)
private val CM_PENDING = JBColor(Color(0xD9A441), Color(0xD9A441))
private val CM_KEPT = JBColor(Color(0x3FB950), Color(0x3FB950))
private val CM_REVERTED = JBColor.GRAY
private val CM_RED = JBColor(Color(0xE5534B), Color(0xE5534B))
private val CM_AGENT = JBColor(Color(0x9A6AC2), Color(0x9A6AC2))

/** status → colour. "undone" surfaces as "reverted" grey, matching the VS Code renderer. */
private fun statusColor(status: String): JBColor = when (status) {
    "pending" -> CM_PENDING
    "undone" -> CM_REVERTED
    else -> CM_KEPT
}

/**
 * Change Map: the session's changes at a glance — Claude's own to-do "chapters" across the top, a
 * one-row module proportion strip ("where did the work land"), and every touched file ranked by churn
 * with a bar. Parity with the VS Code Change Map panel; fed by the CLI `changemap --json` (the single
 * backend), which computes every rollup so this panel only paints. Double-click a row to open that
 * file's most recent edit for review.
 *
 * Natively painted Swing, deliberately no JCEF — same rationale as StatsPanel (fragile under
 * Gateway / remote dev, and these are simple bars).
 */
class ChangeMapPanel(private val project: Project) : SimpleToolWindowPanel(true, true) {

    @Volatile private var map: ChangeMap? = null
    @Volatile private var byCount = false // the ± lines ⇄ count toggle (a render-time choice)
    private var brush: String? = null // active chapter id
    private var modFilter: String? = null // active module bucket

    private val chips = JBLabel().apply { font = JBUI.Fonts.miniFont() }
    private val chaptersBar = JPanel().apply { layout = BoxLayout(this, BoxLayout.X_AXIS) }
    private val strip = StripBar()
    private val listModel = DefaultListModel<ChangeMapFile>()
    private val list = JBList(listModel).apply {
        cellRenderer = LedgerRenderer()
        emptyText.text = "No edits in this session yet — this fills in as Claude edits files"
    }
    private val readout = JBLabel().apply { font = JBUI.Fonts.miniFont(); foreground = UIUtil.getContextHelpForeground() }

    init {
        val north = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            border = JBUI.Borders.empty(2, 4)
            add(chips)
            add(chaptersBar)
            add(strip)
        }
        val root = JPanel(BorderLayout()).apply {
            add(north, BorderLayout.NORTH)
            add(JBScrollPane(list), BorderLayout.CENTER)
            add(readout, BorderLayout.SOUTH)
        }
        setContent(root)

        val toggle = object : ToggleAction("Size by Edit Count", "Size bars by edit count instead of ± lines", AllIcons.Actions.ListChanges), DumbAware {
            override fun getActionUpdateThread() = ActionUpdateThread.EDT
            override fun isSelected(e: AnActionEvent) = byCount
            override fun setSelected(e: AnActionEvent, state: Boolean) {
                byCount = state
                paint()
            }
        }
        val group = DefaultActionGroup(toggle, action("Refresh", AllIcons.Actions.Refresh) { rebuild() })
        val tb = ActionManager.getInstance().createActionToolbar("ClaudeObservatoryChangeMap", group, true)
        tb.targetComponent = list
        toolbar = tb.component

        // Double-click a ledger row → open that file's most recent edit (core hands us maxId).
        list.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) {
                if (e.clickCount != 2) return
                val f = list.selectedValue ?: return
                if (f.maxId < 0) return
                val session = ObservatoryService.getInstance(project).currentSession() ?: return
                val rec = StoreReader.findRecord(session, f.maxId) ?: return
                Navigate.openFileAtEdit(project, session, rec)
            }
        })

        strip.onClick = { m ->
            modFilter = if (modFilter == m) null else m
            paint()
        }

        ObservatoryService.getInstance(project).addListener { rebuild() }
        rebuild()
    }

    private fun rebuild() {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession()
        if (session == null) {
            map = null
            ApplicationManager.getApplication().invokeLater { if (!project.isDisposed) paint() }
            return
        }
        val workDir = service.workspaceRoot
        // The CLI call spawns a process — off the EDT; repaint back on it.
        ApplicationManager.getApplication().executeOnPooledThread {
            val res = ObservatoryCli.changemapJson(session, workDir)?.let { ChangeMapParser.parse(it) }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                map = res
                paint()
            }
        }
    }

    private fun weight(churn: Int, cnt: Int): Int = if (byCount) cnt else maxOf(1, churn)

    private fun inChapter(chapters: List<String>): Boolean = brush == null || chapters.contains(brush)

    private fun paint() {
        val m = map
        chaptersBar.removeAll()
        if (m == null) {
            chips.text = ""
            listModel.clear()
            strip.update(emptyList(), null, null, byCount)
            readout.text = ""
            revalidateAll()
            return
        }
        val s = m.summary
        if (s != null) {
            val reviewed = s.kept + s.undone
            val total = s.pending + reviewed
            val pct = if (total > 0) reviewed * 100 / total else 0
            // Same headline set, in the same order, as the VS Code panel's chips.
            chips.text = buildString {
                append("${s.units} edits")
                if (s.pending > 0) append("  ·  ${s.pending} pending")
                if (s.kept > 0) append("  ·  ${s.kept} kept")
                if (s.undone > 0) append("  ·  ${s.undone} reverted")
                append("  ·  $pct% reviewed")
                if (s.subagents > 0) append("  ·  ${s.subagents} agents")
                if (s.errors > 0) append("  ·  ${s.errors} err")
                if (s.fleet > 0) append("  ·  🛰 ${s.fleet}")
                if (s.egress > 0) append("  ·  ⇅ ${s.egress}")
            }
        }

        // Chapters on top — Claude's own to-dos. Click to brush the map to that chapter's files.
        for (c in m.chapters) {
            val glyph = when (c.status) {
                "done" -> "●"
                "wip" -> "◐"
                else -> "○"
            }
            val btn = JToggleButton("$glyph ${c.index + 1}. ${c.title}")
            btn.isSelected = brush == c.id
            btn.font = JBUI.Fonts.miniFont()
            btn.toolTipText = "${c.title} — ${c.edits} edit(s) · ${c.status}" + if (c.agent) " · subagent" else ""
            btn.foreground = when (c.status) {
                "done" -> CM_KEPT
                "wip" -> CM_PENDING
                else -> UIUtil.getContextHelpForeground()
            }
            btn.addActionListener {
                brush = if (brush == c.id) null else c.id
                paint()
            }
            chaptersBar.add(btn)
        }

        strip.update(m.modules, modFilter, brush, byCount)

        val shown = m.files.filter { inChapter(it.chapters) && (modFilter == null || it.module == modFilter) }
        val ranked = if (byCount) shown.sortedWith(compareByDescending<ChangeMapFile> { it.cnt }.thenBy { it.rel }) else shown
        listModel.clear()
        val max = ranked.maxOfOrNull { weight(it.churn, it.cnt) } ?: 1
        (list.cellRenderer as LedgerRenderer).configure(max.coerceAtLeast(1), byCount)
        ranked.forEach { listModel.addElement(it) }

        val bits = mutableListOf<String>()
        brush?.let { b -> m.chapters.find { it.id == b }?.let { bits.add("chapter ${it.index + 1} · ${it.title}") } }
        modFilter?.let { mf -> m.modules.find { it.module == mf }?.let { bits.add("module ${it.label}") } }
        readout.text = if (bits.isEmpty()) "" else "filtered by " + bits.joinToString(" + ") + " — click again to clear"
        revalidateAll()
    }

    private fun revalidateAll() {
        chaptersBar.revalidate()
        chaptersBar.repaint()
        strip.repaint()
        revalidate()
        repaint()
    }

    private fun action(text: String, icon: Icon, run: () -> Unit): AnAction =
        object : AnAction(text, null, icon), DumbAware {
            override fun actionPerformed(e: AnActionEvent) = run()
        }

    /** The one-row module proportion strip: width ∝ churn (or count), colour = worst-unreviewed-wins. */
    private inner class StripBar : JComponent() {
        private var mods: List<ChangeMapModule> = emptyList()
        private var sel: String? = null
        private var brushed: String? = null
        private var count = false
        private var hit: List<Triple<Int, Int, ChangeMapModule>> = emptyList() // x0, x1, module
        var onClick: ((String) -> Unit)? = null

        init {
            preferredSize = Dimension(JBUI.scale(200), JBUI.scale(14))
            maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(14))
            minimumSize = Dimension(JBUI.scale(60), JBUI.scale(14))
            toolTipText = "" // registers the component with ToolTipManager
            addMouseListener(object : MouseAdapter() {
                override fun mouseClicked(e: MouseEvent) {
                    hit.firstOrNull { e.x >= it.first && e.x < it.second }?.let { onClick?.invoke(it.third.module) }
                }
            })
        }

        fun update(modules: List<ChangeMapModule>, selected: String?, brush: String?, byCount: Boolean) {
            mods = modules
            sel = selected
            brushed = brush
            count = byCount
            repaint()
        }

        override fun getToolTipText(e: MouseEvent): String? =
            hit.firstOrNull { e.x >= it.first && e.x < it.second }?.third?.let { m ->
                "${m.label} · ${if (count) "${m.cnt} edits" else "${m.churn} lines"} · ${m.files} file(s)"
            }

        override fun paintComponent(g: Graphics) {
            val g2 = g as Graphics2D
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            val ordered = if (count) mods.sortedWith(compareByDescending<ChangeMapModule> { it.cnt }.thenBy { it.module }) else mods
            val total = ordered.sumOf { if (count) it.cnt else maxOf(1, it.churn) }.coerceAtLeast(1)
            val h = height
            var x = 0
            val acc = mutableListOf<Triple<Int, Int, ChangeMapModule>>()
            for (m in ordered) {
                val w = ((if (count) m.cnt else maxOf(1, m.churn)).toDouble() / total * width).toInt().coerceAtLeast(2)
                val dim = brushed != null && !m.chapters.contains(brushed)
                val isSel = sel == m.module
                val base = statusColor(m.status)
                g2.color = when {
                    dim -> UIUtil.toAlpha(base, 40)
                    sel != null && !isSel -> UIUtil.toAlpha(base, 90)
                    else -> base
                }
                g2.fillRect(x, 0, w, h)
                if (isSel) {
                    g2.color = UIUtil.getLabelForeground()
                    g2.drawRect(x, 0, w - 1, h - 1)
                }
                acc.add(Triple(x, x + w, m))
                x += w
            }
            hit = acc
        }
    }

    /** One ledger row: status dot · file · module · churn bar · ±lines · pending count. */
    private inner class LedgerRenderer : JComponent(), ListCellRenderer<ChangeMapFile> {
        private var value: ChangeMapFile? = null
        private var selected = false
        private var max = 1
        private var count = false

        init {
            preferredSize = Dimension(JBUI.scale(200), JBUI.scale(18))
        }

        fun configure(max: Int, byCount: Boolean) {
            this.max = max
            this.count = byCount
        }

        override fun getListCellRendererComponent(
            list: JList<out ChangeMapFile>, v: ChangeMapFile, index: Int, isSelected: Boolean, cellHasFocus: Boolean,
        ): Component {
            value = v
            selected = isSelected
            toolTipText = buildString {
                append(v.rel)
                append("\n+${v.churn} · ${v.cnt} unit(s) · ${v.kept}✓ ${v.pending}⏳ ${v.undone}↩")
                if (v.classes.isNotEmpty()) append("\n" + v.classes.take(4).joinToString(", "))
                v.reason?.let { append("\n“$it”") }
                v.risk?.let { append("\n⚠ $it") }
                append("\nDouble-click → open the diff")
            }
            return this
        }

        override fun paintComponent(g: Graphics) {
            val v = value ?: return
            val g2 = g as Graphics2D
            g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
            if (selected) {
                g2.color = UIUtil.getListSelectionBackground(true)
                g2.fillRect(0, 0, width, height)
            }
            val fg = if (selected) UIUtil.getListSelectionForeground(true) else UIUtil.getLabelForeground()
            val grey = if (selected) UIUtil.getListSelectionForeground(true) else UIUtil.getContextHelpForeground()
            val col = statusColor(v.status)
            val mid = height / 2

            var x = JBUI.scale(3)
            g2.color = col // status dot
            g2.fillRoundRect(x, mid - JBUI.scale(3), JBUI.scale(6), JBUI.scale(6), 2, 2)
            x += JBUI.scale(11)

            g2.font = JBUI.Fonts.miniFont()
            g2.color = fg
            val nameW = JBUI.scale(120)
            g2.drawString(clip(g2, v.file + (if (v.agent) " ●" else "") + (if (v.risk != null) " ⌐" else ""), nameW), x, mid + JBUI.scale(3))
            x += nameW + JBUI.scale(4)

            g2.color = grey
            val modW = JBUI.scale(60)
            g2.drawString(clip(g2, v.moduleLabel, modW), x, mid + JBUI.scale(3))
            x += modW + JBUI.scale(6)

            val numW = JBUI.scale(46)
            val pendW = JBUI.scale(28)
            val barW = (width - x - numW - pendW - JBUI.scale(8)).coerceAtLeast(JBUI.scale(16))
            g2.color = JBColor.border() // bar track
            g2.fillRoundRect(x, mid - JBUI.scale(2), barW, JBUI.scale(4), 3, 3)
            val w = weightOf(v)
            val fill = (barW.toDouble() * w / max).toInt().coerceAtLeast(2)
            g2.color = col
            g2.fillRoundRect(x, mid - JBUI.scale(2), fill, JBUI.scale(4), 3, 3)
            x += barW + JBUI.scale(6)

            g2.color = grey
            val num = if (count) "${v.cnt}e" else "+${v.churn}"
            g2.drawString(num, x + numW - g2.fontMetrics.stringWidth(num), mid + JBUI.scale(3))
            x += numW + JBUI.scale(4)

            val pend = if (v.pending > 0) "${v.pending}⏳" else "✓"
            g2.color = if (v.pending > 0) CM_PENDING else CM_KEPT
            g2.drawString(pend, x + pendW - g2.fontMetrics.stringWidth(pend), mid + JBUI.scale(3))
        }

        private fun weightOf(v: ChangeMapFile): Int = if (count) v.cnt else maxOf(1, v.churn)

        private fun clip(g2: Graphics2D, s: String, w: Int): String {
            if (g2.fontMetrics.stringWidth(s) <= w) return s
            var t = s
            while (t.isNotEmpty() && g2.fontMetrics.stringWidth("$t…") > w) t = t.dropLast(1)
            return "$t…"
        }
    }
}
