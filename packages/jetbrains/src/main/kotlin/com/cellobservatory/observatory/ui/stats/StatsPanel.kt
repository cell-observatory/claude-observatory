package com.cellobservatory.observatory.ui.stats

import com.cellobservatory.observatory.core.ObservatoryCli
import com.cellobservatory.observatory.services.ObservatoryService
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.concurrency.AppExecutorUtil
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.RenderingHints
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.ButtonGroup
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JToggleButton
import javax.swing.Timer
import kotlin.math.ln
import kotlin.math.max

// Chart palette (mirrors the VS Code webview's theme-variable choices).
private val C_PENDING = JBColor(Color(0xD9A441), Color(0xD9A441))
private val C_KEPT = JBColor(Color(0x3FB950), Color(0x3FB950))
private val C_REVERTED = JBColor.GRAY
private val C_TOTAL = JBColor(Color(0x4C8BF5), Color(0x4C8BF5))
private val C_INPUT = JBColor(Color(0x9A6AC2), Color(0x9A6AC2))
private val C_OUTPUT = JBColor(Color(0xC9713F), Color(0xC9713F))
private val C_RED = JBColor(Color(0xE5534B), Color(0xE5534B))

private data class Bucket(
    val label: String,
    val editsPending: Double, val editsKept: Double, val editsUndone: Double,
    val tokensInput: Double, val tokensOutput: Double,
) { val tokensTotal get() = tokensInput + tokensOutput }

private data class Usage(
    val ctxPct: Double?, val ctxTokens: Double?, val ctxSize: Double?,
    val fivePct: Double?, val fiveReset: Long?, val fiveTok: Double?,
    val weekPct: Double?, val weekReset: Long?, val weekTok: Double?,
    val statuslineCache: Boolean, val cachedAtMs: Long?, val staleMs: Long,
)

private fun human(n: Double): String {
    if (!n.isFinite()) return "0"
    if (n < 1000) return n.toInt().toString()
    val (v, suf) = when {
        n < 1e6 -> n / 1e3 to "k"
        n < 1e9 -> n / 1e6 to "M"
        else -> n / 1e9 to "B"
    }
    val s = if (v < 10) String.format("%.1f", v) else v.toInt().toString()
    return (if (s.endsWith(".0")) s.dropLast(2) else s) + suf
}

private fun until(ms: Long?): String {
    if (ms == null) return ""
    val d = ms - System.currentTimeMillis()
    if (d <= 0) return ""
    val mins = (d / 60000).toInt()
    val h = mins / 60
    if (h >= 24) return "${h / 24}d${h % 24}h"
    return if (h > 0) "${h}h${mins % 60}m" else "${mins % 60}m"
}

private fun ago(ms: Long): String {
    val m = (ms / 60000).toInt()
    if (m < 60) return "${m}m"
    val h = m / 60
    if (h < 24) return "${h}h" + if (m % 60 > 0) "${m % 60}m" else ""
    return "${h / 24}d"
}

/**
 * Stats + Usage, painted natively in Swing (deliberately no JCEF — fragile under Gateway/remote
 * dev, and the plots are simple step-lines). Edits (linear) + Tokens (log) with a Today/7d/30d
 * toggle and crosshair tooltips; below, the ctx/5h/wk usage bars with reset countdowns, ~token
 * estimates, and the v0.1.2 staleness stamps ("Xm ago" + terminal hint when the statusline cache
 * is older than USAGE_STALE_MS, since IDE panels never run Claude's statusLine).
 */
class StatsPanel(private val project: Project) : JPanel(BorderLayout()), com.intellij.openapi.Disposable {

    private var series: Map<String, List<Bucket>> = emptyMap()
    private var usage: Usage? = null
    private var range = "week"
    private var statsEverLoaded = false
    private var lastStatsRun = 0L
    private var statsRunning = false
    // Held so dispose() can stop them — otherwise the Swing TimerQueue + the service listener keep the
    // panel (and the captured, now-disposed Project) reachable after the tool window/project closes.
    private val serviceListener = Runnable { refresh() }
    private var refreshTimer: Timer? = null

    private val gathering = JBLabel("Gathering stats…").apply {
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(8)
        toolTipText = "First scan of your transcripts; cached after"
    }
    private val scoreboard = ReviewScoreboard()
    private val tokensChart = ChartComponent(
        "TOKENS", true,
        listOf(Triple("total", C_TOTAL) { b: Bucket -> b.tokensTotal },
            Triple("input", C_INPUT) { b: Bucket -> b.tokensInput },
            Triple("output", C_OUTPUT) { b: Bucket -> b.tokensOutput }),
    )
    private val usageBars = UsageBars()
    private val hint = JBLabel().apply {
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(4, 8)
        isVisible = false
    }
    // Stats top navbar (parity with the VS Code Stats navbar): the active session only — Search-edits
    // lives on the review nav bar (Overview toolbar + status bar), as in VS Code.
    private val sessionLabel = JBLabel().apply {
        foreground = UIUtil.getContextHelpForeground()
        toolTipText = "Active Claude Code session"
    }

    init {
        val ranges = JPanel(FlowLayout(FlowLayout.LEFT, JBUI.scale(4), JBUI.scale(4)))
        val group = ButtonGroup()
        for ((key, label) in listOf("today" to "Today", "week" to "7 days", "month" to "30 days")) {
            val b = JToggleButton(label, key == range)
            b.addActionListener { range = key; repaintCharts() }
            group.add(b)
            ranges.add(b)
        }
        // Top navbar: the active session, above the range toggle. Clicking the scoreboard's PENDING
        // column jumps to the first edit to review.
        val navbar = JPanel(BorderLayout(JBUI.scale(8), 0)).apply {
            border = JBUI.Borders.empty(4, 8, 3, 8)
            add(sessionLabel, BorderLayout.WEST)
        }
        add(JPanel().apply { layout = javax.swing.BoxLayout(this, javax.swing.BoxLayout.Y_AXIS); add(navbar); add(ranges) }, BorderLayout.NORTH)
        scoreboard.toolTipText = "Click the PENDING count to jump to the first edit to review"
        scoreboard.addMouseListener(object : java.awt.event.MouseAdapter() {
            override fun mouseClicked(e: java.awt.event.MouseEvent) { if (e.x < scoreboard.width / 3) reviewFirst() }
        })
        scoreboard.addMouseMotionListener(object : java.awt.event.MouseMotionAdapter() {
            override fun mouseMoved(e: java.awt.event.MouseEvent) {
                scoreboard.cursor = if (e.x < scoreboard.width / 3) java.awt.Cursor.getPredefinedCursor(java.awt.Cursor.HAND_CURSOR) else java.awt.Cursor.getDefaultCursor()
            }
        })

        val stack = ScrollableStack().apply {
            border = JBUI.Borders.empty(4, 8)
            add(gathering)
            add(scoreboard)
            add(Box.createVerticalStrut(JBUI.scale(12)))
            add(tokensChart)
            add(Box.createVerticalStrut(JBUI.scale(12)))
            add(usageBars)
            add(hint)
            add(Box.createVerticalGlue())
        }
        // Track the viewport width so charts/labels re-layout to the ACTUAL pane width — a plain
        // panel in a scroll pane lays out at preferred width and paints off-canvas when squeezed.
        add(JBScrollPane(stack, JBScrollPane.VERTICAL_SCROLLBAR_AS_NEEDED, JBScrollPane.HORIZONTAL_SCROLLBAR_NEVER), BorderLayout.CENTER)

        scoreboard.update(ObservatoryService.getInstance(project).counts()) // populate before first show
        ObservatoryService.getInstance(project).addListener(serviceListener)
        // 30s tick: refresh usage + stale stamps; stats self-throttles to one subprocess per 20s.
        refreshTimer = Timer(30_000) { if (isShowing) refresh() }.apply { isRepeats = true; start() }
        addHierarchyListener { if (isShowing) refresh() }
    }

    override fun dispose() {
        refreshTimer?.stop()
        refreshTimer = null
        ObservatoryService.getInstance(project).removeListener(serviceListener)
    }

    private fun repaintCharts() {
        val buckets = series[range] ?: emptyList()
        tokensChart.update(buckets)
    }

    /** Jump to the first (oldest) pending edit — the scoreboard PENDING-count click target. */
    private fun reviewFirst() {
        val service = ObservatoryService.getInstance(project)
        val session = service.currentSession() ?: return
        val first = service.log().filter { it.pending }.minByOrNull { it.id } ?: return
        com.cellobservatory.observatory.ui.Navigate.openFileAtEdit(project, session, first)
    }

    fun refresh() {
        val session = ObservatoryService.getInstance(project).currentSession()
        sessionLabel.text = "🔬 " + (session?.take(8) ?: "—")
        sessionLabel.toolTipText = session?.let { "Active session: $it" } ?: "No active Claude Code session"
        // Live review scoreboard from the in-memory folded log (cheap; cached on the log's mtime/size).
        scoreboard.update(ObservatoryService.getInstance(project).counts())
        fetchUsage()
        fetchStats()
    }

    private fun fetchStats() {
        val now = System.currentTimeMillis()
        if (statsRunning || now - lastStatsRun < 20_000) return
        statsRunning = true
        lastStatsRun = now
        val session = ObservatoryService.getInstance(project).currentSession()
        AppExecutorUtil.getAppExecutorService().submit {
            val json = ObservatoryCli.statsJson(session, project.basePath)
            val parsed = json?.let { parseStats(it) }
            ApplicationManager.getApplication().invokeLater {
                statsRunning = false
                if (project.isDisposed) return@invokeLater
                if (parsed == null) {
                    if (!statsEverLoaded) {
                        gathering.text = "⚠ Needs the claude-observatory CLI"
                        gathering.toolTipText = "Stats run `claude-observatory stats --json` — install the CLI on this machine, then reopen this tab."
                    }
                } else {
                    statsEverLoaded = true
                    gathering.isVisible = false
                    series = parsed
                    repaintCharts()
                }
            }
        }
    }

    private fun fetchUsage() {
        AppExecutorUtil.getAppExecutorService().submit {
            val u = ObservatoryCli.usageJson(project.basePath)?.let { parseUsage(it) }
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                usage = u ?: usage
                usageBars.update(usage)
                updateHint()
            }
        }
    }

    private fun updateHint() {
        val u = usage ?: return
        val age = if (u.statuslineCache && u.cachedAtMs != null) System.currentTimeMillis() - u.cachedAtMs else null
        hint.isVisible = true
        when {
            !u.statuslineCache -> {
                hint.text = "<html>Run <b>claude-observatory statusline</b> for 5h/wk usage</html>"
                hint.toolTipText = "5h/week plan usage needs claude-statusline writing on this host — it's bundled with the CLI; start a Claude session after installing."
            }
            age != null && age > u.staleMs -> {
                hint.text = "<html>5h / week last refreshed <b>${ago(age)} ago</b> — keep an idle <b>claude</b> terminal open (it refreshes every ~60s).<br>Plan usage comes only from Claude's own status line; ctx stays live from the transcript.</html>"
                hint.toolTipText = "5h/week are account-wide plan limits the IDE panel can't fetch itself — only Claude's status line has them, and it re-runs every ~60s (refreshInterval) while a claude session is open. ctx stays live from the transcript."
            }
            else -> hint.isVisible = false
        }
    }

    // --- parsing ---

    private fun parseStats(json: String): Map<String, List<Bucket>>? = try {
        val o = JsonParser.parseString(json).asJsonObject
        if (!o.has("daily") || !o.has("hourly")) null else { // guard against a foreign binary's JSON
            val daily = o.getAsJsonArray("daily").map { bucketOf(it.asJsonObject, dayLabel(it.asJsonObject)) }
            val hourly = o.getAsJsonArray("hourly").map { bucketOf(it.asJsonObject, "${it.asJsonObject.get("hour").asInt}:00") }
            mapOf("today" to hourly, "week" to daily.takeLast(7), "month" to daily)
        }
    } catch (_: Exception) {
        null
    }

    private fun dayLabel(o: JsonObject): String {
        val p = o.get("day").asString.split("-")
        return if (p.size == 3) "${p[1].toInt()}/${p[2].toInt()}" else o.get("day").asString
    }

    private fun bucketOf(o: JsonObject, label: String) = Bucket(
        label = label,
        editsPending = o.get("editsPending")?.asDouble ?: 0.0,
        editsKept = o.get("editsKept")?.asDouble ?: 0.0,
        editsUndone = o.get("editsUndone")?.asDouble ?: 0.0,
        tokensInput = o.get("tokensInput")?.asDouble ?: 0.0,
        tokensOutput = o.get("tokensOutput")?.asDouble ?: 0.0,
    )

    private fun parseUsage(json: String): Usage? = try {
        val o = JsonParser.parseString(json).asJsonObject
        val ctx = o.get("ctx")?.takeIf { it.isJsonObject }?.asJsonObject
        fun num(el: com.google.gson.JsonElement?): Double? =
            el?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asDouble
        fun lng(el: com.google.gson.JsonElement?): Long? =
            el?.takeIf { it.isJsonPrimitive && it.asJsonPrimitive.isNumber }?.asLong
        Usage(
            ctxPct = num(ctx?.get("pct")), ctxTokens = num(ctx?.get("tokens")), ctxSize = num(ctx?.get("size")),
            fivePct = num(o.get("fiveHourPct")), fiveReset = lng(o.get("fiveReset")), fiveTok = num(o.get("fiveTokens")),
            weekPct = num(o.get("weekPct")), weekReset = lng(o.get("weekReset")), weekTok = num(o.get("weekTokens")),
            statuslineCache = o.get("statuslineCache")?.asBoolean ?: false,
            cachedAtMs = lng(o.get("cachedAtMs")),
            staleMs = lng(o.get("staleMs")) ?: 300_000L,
        )
    } catch (_: Exception) {
        null
    }
}

/** A vertical stack whose width always tracks the scroll viewport, so children lay out and paint
 *  at the REAL pane width instead of their preferred width (which long labels would inflate). */
private class ScrollableStack : JPanel(), javax.swing.Scrollable {
    init {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
    }

    override fun getPreferredScrollableViewportSize(): Dimension = preferredSize
    override fun getScrollableUnitIncrement(r: java.awt.Rectangle, o: Int, d: Int) = JBUI.scale(16)
    override fun getScrollableBlockIncrement(r: java.awt.Rectangle, o: Int, d: Int) = JBUI.scale(64)
    override fun getScrollableTracksViewportWidth() = true
    override fun getScrollableTracksViewportHeight() = false
}

/** Live review scoreboard: current pending / accepted / reverted counts + a progress bar that fills as
 *  edits get reviewed. Fed from ObservatoryService.counts() on every store change — parity with the VS
 *  Code Stats webview's review section (natively painted, consistent with the charts below). */
private class ReviewScoreboard : JComponent() {
    private var c: ObservatoryService.Counts? = null

    init {
        preferredSize = Dimension(JBUI.scale(200), JBUI.scale(80))
        minimumSize = Dimension(JBUI.scale(110), JBUI.scale(80))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(86))
    }

    fun update(counts: ObservatoryService.Counts?) {
        c = counts
        repaint()
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        val grey = UIUtil.getContextHelpForeground()
        val counts = c ?: ObservatoryService.Counts(0, 0, 0, null)
        val cells = listOf(
            Triple("PENDING", counts.pending, C_PENDING),
            Triple("ACCEPTED", counts.kept, C_KEPT),
            Triple("REVERTED", counts.undone, C_REVERTED),
        )
        val gap = JBUI.scale(6)
        val cellW = (width - 2 * gap) / 3
        val cellH = JBUI.scale(44)
        var x = 0
        for ((label, value, color) in cells) {
            g2.color = JBColor.border()
            g2.drawRoundRect(x, 0, cellW - 1, cellH, JBUI.scale(6), JBUI.scale(6))
            g2.color = color
            g2.font = JBUI.Fonts.label(16f).asBold()
            val num = value.toString()
            g2.drawString(num, x + (cellW - g2.fontMetrics.stringWidth(num)) / 2, JBUI.scale(25))
            g2.color = grey
            g2.font = JBUI.Fonts.miniFont()
            g2.drawString(label, x + (cellW - g2.fontMetrics.stringWidth(label)) / 2, JBUI.scale(39))
            x += cellW + gap
        }
        val reviewed = counts.kept + counts.undone
        val total = counts.pending + reviewed
        val pct = if (total > 0) reviewed.toDouble() / total else 0.0
        val barY = cellH + JBUI.scale(10)
        val barH = JBUI.scale(5)
        g2.color = JBColor.border()
        g2.fillRoundRect(0, barY, width, barH, 4, 4)
        if (total > 0) {
            g2.color = if (pct >= 1.0) C_KEPT else C_TOTAL
            g2.fillRoundRect(0, barY, (width * pct).toInt().coerceAtLeast(2), barH, 4, 4)
        }
        g2.color = grey
        g2.font = JBUI.Fonts.miniFont()
        val progress = if (total > 0) "$reviewed of $total reviewed (${(pct * 100).toInt()}%)" else "no edits yet"
        g2.drawString(progress, JBUI.scale(2), barY + JBUI.scale(18))
        if (reviewed > 0) {
            val rate = "${(counts.kept.toDouble() / reviewed * 100).toInt()}% accepted"
            g2.drawString(rate, width - g2.fontMetrics.stringWidth(rate) - JBUI.scale(2), barY + JBUI.scale(18))
        }
    }
}

/** Multi-series step-line chart with y ticks (linear or log) and a crosshair tooltip. */
private class ChartComponent(
    private val title: String,
    private val logScale: Boolean,
    private val seriesSpec: List<Triple<String, Color, (Bucket) -> Double>>,
) : JComponent() {

    private var buckets: List<Bucket> = emptyList()
    private var hover = -1

    init {
        // Narrow-pane friendly: the Dashboards window shows three panes side by side, so this
        // chart must render sensibly from ~a quarter of a tool window up to full width.
        preferredSize = Dimension(JBUI.scale(200), JBUI.scale(96))
        minimumSize = Dimension(JBUI.scale(110), JBUI.scale(90))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(110))
        val mouse = object : MouseAdapter() {
            override fun mouseMoved(e: MouseEvent) {
                if (buckets.isEmpty()) return
                val plotX = e.x - JBUI.scale(36)
                val w = width - JBUI.scale(44)
                hover = if (plotX in 0..w) (plotX * buckets.size / max(1, w)).coerceIn(0, buckets.size - 1) else -1
                toolTipText = if (hover >= 0) buckets[hover].let { b ->
                    "${b.label} · " + seriesSpec.joinToString(" · ") { (n, _, f) -> "$n ${human(f(b))}" }
                } else null
                repaint()
            }

            override fun mouseExited(e: MouseEvent) {
                hover = -1
                repaint()
            }
        }
        addMouseMotionListener(mouse)
        addMouseListener(mouse)
    }

    fun update(b: List<Bucket>) {
        buckets = b
        repaint()
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        val left = JBUI.scale(36)
        val plotW = width - left - JBUI.scale(8)
        val plotH = height - JBUI.scale(30)
        val top = JBUI.scale(14)
        val grey = UIUtil.getContextHelpForeground()

        g2.color = grey
        g2.font = JBUI.Fonts.miniFont()
        g2.drawString(title, left, JBUI.scale(10))
        var lx = left + g2.fontMetrics.stringWidth(title) + JBUI.scale(12)
        for ((name, color, _) in seriesSpec) {
            val entryW = JBUI.scale(12) + g2.fontMetrics.stringWidth(name) + JBUI.scale(10)
            if (lx + entryW > width) break // narrow pane: drop trailing legend entries, don't overlap
            g2.color = color
            g2.fillRect(lx, JBUI.scale(5), JBUI.scale(9), JBUI.scale(3))
            g2.color = grey
            g2.drawString(name, lx + JBUI.scale(12), JBUI.scale(10))
            lx += entryW
        }
        if (buckets.isEmpty()) return

        var maxV = 1.0
        for ((_, _, f) in seriesSpec) for (b in buckets) maxV = max(maxV, f(b))
        fun yOf(v: Double): Int {
            val h = plotH - top
            val frac = if (logScale) (if (v < 1) 0.0 else ln(v) / ln(max(2.0, maxV))) else v / maxV
            return top + h - (frac * (h - 3)).toInt()
        }

        // baseline + y ticks (drawn top-down, skipping any tick within 14px of the previous —
        // the same min-separation guard as the VS Code chart, so labels never crowd or overlap)
        g2.color = JBColor.border()
        g2.drawLine(left, plotH, left + plotW, plotH)
        g2.color = grey
        val ticks = if (logScale) {
            generateSequence(1.0) { it * 10 }.takeWhile { it <= maxV }.toList().takeLast(3)
        } else listOf(maxV, maxV / 2).filter { it >= 1 }
        var lastTickY = Int.MIN_VALUE
        for (t in ticks.sortedDescending()) {
            val yy = yOf(t)
            if (lastTickY != Int.MIN_VALUE && kotlin.math.abs(yy - lastTickY) < JBUI.scale(14)) continue
            g2.drawString(human(t), JBUI.scale(2), yy + JBUI.scale(4))
            lastTickY = yy
        }

        val n = buckets.size
        for ((_, color, f) in seriesSpec) {
            g2.color = color
            var prevY = -1
            for (i in 0 until n) {
                val x0 = left + i * plotW / n
                val x1 = left + (i + 1) * plotW / n
                val y = yOf(f(buckets[i]))
                if (prevY >= 0) g2.drawLine(x0, prevY, x0, y)
                g2.drawLine(x0, y, x1, y)
                prevY = y
            }
        }

        if (hover in 0 until n) {
            g2.color = UIUtil.getLabelForeground()
            val cx = left + hover * plotW / n + plotW / (2 * n)
            g2.drawLine(cx, top, cx, plotH)
        }

        // x labels — count adapts to the pane width so narrow panes don't overlap labels
        g2.color = grey
        val m = minOf(6, n, max(2, plotW / JBUI.scale(56)))
        for (k in 0 until m) {
            val idx = if (m == 1) 0 else k * (n - 1) / (m - 1)
            val label = buckets[idx].label
            val x = left + (idx * plotW / n).coerceAtMost(plotW - g2.fontMetrics.stringWidth(label))
            g2.drawString(label, x, height - JBUI.scale(4))
        }
    }
}

/** The ctx / 5h / wk usage bars with color thresholds, countdowns, and ~token estimates. */
private class UsageBars : JComponent() {
    private var u: Usage? = null

    init {
        preferredSize = Dimension(JBUI.scale(200), JBUI.scale(70))
        minimumSize = Dimension(JBUI.scale(110), JBUI.scale(70))
        maximumSize = Dimension(Int.MAX_VALUE, JBUI.scale(70))
    }

    fun update(usage: Usage?) {
        u = usage
        repaint()
    }

    private fun colorFor(pct: Double) = when {
        pct >= 80 -> C_RED
        pct >= 50 -> C_PENDING
        else -> C_KEPT
    }

    override fun paintComponent(g: Graphics) {
        val g2 = g as Graphics2D
        g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
        g2.font = JBUI.Fonts.miniFont()
        val grey = UIUtil.getContextHelpForeground()
        g2.color = grey
        g2.drawString("USAGE", JBUI.scale(2), JBUI.scale(10))
        val usage = u
        val rows: List<Triple<String, Double?, String>> = if (usage == null) {
            listOf(Triple("ctx", null, ""), Triple("5h", null, ""), Triple("wk", null, ""))
        } else {
            val age = if (usage.statuslineCache && usage.cachedAtMs != null) System.currentTimeMillis() - usage.cachedAtMs else null
            val stale = if (age != null && age > usage.staleMs) " · ${ago(age)} ago" else ""
            listOf(
                Triple("ctx", usage.ctxPct, usage.ctxTokens?.let { t -> "${human(t)}/${human(usage.ctxSize ?: 0.0)}" } ?: ""),
                Triple("5h", usage.fivePct, listOfNotNull(until(usage.fiveReset).ifBlank { null }, usage.fiveTok?.let { "~${human(it)}" }).joinToString(" · ") + stale),
                Triple("wk", usage.weekPct, listOfNotNull(until(usage.weekReset).ifBlank { null }, usage.weekTok?.let { "~${human(it)}" }).joinToString(" · ") + stale),
            )
        }
        // Full-width responsive rows (same idea as the charts tracking the viewport): per row the
        // track flexes to fill everything the label/%/detail don't need; the detail column drops
        // first when the pane narrows, keeping the bar itself as wide as possible.
        var y = JBUI.scale(20)
        val fm = g2.fontMetrics
        val trackX = JBUI.scale(28)
        val pctW = JBUI.scale(34)
        for ((label, pct, sub) in rows) {
            val subW = if (sub.isBlank()) 0 else fm.stringWidth(sub) + JBUI.scale(10)
            var track = width - trackX - pctW - subW - JBUI.scale(10)
            val showSub = track >= JBUI.scale(60) && subW > 0
            if (!showSub) track = width - trackX - pctW - JBUI.scale(10)
            track = track.coerceAtLeast(JBUI.scale(40))
            g2.color = grey
            g2.drawString(label, JBUI.scale(2), y + JBUI.scale(4))
            g2.color = JBColor.border()
            g2.fillRoundRect(trackX, y, track, JBUI.scale(5), 4, 4)
            if (pct != null) {
                val c = colorFor(pct)
                g2.color = c
                g2.fillRoundRect(trackX, y, (track * (pct.coerceIn(0.0, 100.0) / 100)).toInt().coerceAtLeast(2), JBUI.scale(5), 4, 4)
                g2.drawString("${pct.toInt()}%", trackX + track + JBUI.scale(6), y + JBUI.scale(4))
                if (showSub) {
                    g2.color = grey
                    g2.drawString(sub, trackX + track + pctW, y + JBUI.scale(4))
                }
            } else {
                g2.color = grey
                g2.drawString("—", trackX + track + JBUI.scale(6), y + JBUI.scale(4))
            }
            y += JBUI.scale(16)
        }
        toolTipText = rows.joinToString("  ·  ") { (l, p, s) -> "$l ${p?.toInt()?.toString()?.plus("%") ?: "—"} $s".trim() }
    }
}
