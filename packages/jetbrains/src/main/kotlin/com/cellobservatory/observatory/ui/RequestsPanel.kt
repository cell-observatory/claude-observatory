package com.cellobservatory.observatory.ui

import com.cellobservatory.observatory.model.RequestResponse
import com.cellobservatory.observatory.model.RequestsResult
import com.cellobservatory.observatory.model.SessionRequest
import com.cellobservatory.observatory.services.ObservatoryService
import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.Project
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.Component
import java.awt.Font
import javax.swing.DefaultListModel
import javax.swing.JList
import javax.swing.JPanel
import javax.swing.ListCellRenderer
import javax.swing.ListSelectionModel

/**
 * The REQUESTS window (0.8.7) — the dashboards' left pane, beside the Overview rather than inside it.
 *
 * Every other surface organizes the session the way the AGENT saw it: worktrees, runs, to-dos, files.
 * This one is the session as the conversation actually went — one row per thing the user asked for, in
 * order, each carrying what that ask produced. It is its own window because selecting a request SCOPES
 * the Overview next to it (fleet · runs · tasks · shells, and the whole change map); a tab would hide
 * the list the moment you looked at what it filtered.
 *
 * The selection lives on the service, so the two windows can never disagree about it.
 */
class RequestsPanel(private val project: Project) : JPanel(BorderLayout()) {
    private fun service() = ObservatoryService.getInstance(project)

    private val model = DefaultListModel<SessionRequest>()
    private val list = JBList(model).apply {
        selectionMode = ListSelectionModel.SINGLE_SELECTION
        cellRenderer = RequestRowRenderer()
        // Rows are as tall as their ask needs — the renderer measures each one, so no fixed height.
        fixedCellHeight = -1
        emptyText.text = "Reading this session’s requests…"
    }
    private val head = JBLabel("").apply {
        font = JBUI.Fonts.label().deriveFont(Font.PLAIN, JBUI.Fonts.label().size2D - 1f)
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(3, 8, 2, 8)
    }
    private val desc = JBLabel(
        "<html>What you asked for, in order. Select one to scope the Overview beside it — its fleet, " +
            "runs, tasks, shells and change map narrow to the work that ask caused.</html>"
    ).apply {
        font = JBUI.Fonts.label().deriveFont(Font.PLAIN, JBUI.Fonts.label().size2D - 1f)
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(0, 8, 4, 8)
    }
    private var last: RequestsResult? = null
    /** Guards the listener→selection→listener loop while the panel is repainting itself. */
    private var syncing = false

    // --- Claude's response viewer (0.8.7): read the selected ask's reply below the list ---
    private val responseHead = JBLabel("Select a request to read Claude's response").apply {
        font = JBUI.Fonts.label().deriveFont(Font.PLAIN, JBUI.Fonts.label().size2D - 1f)
        foreground = UIUtil.getContextHelpForeground()
        border = JBUI.Borders.empty(3, 8, 2, 8)
    }
    private val responseText = com.intellij.ui.components.JBTextArea().apply {
        isEditable = false
        lineWrap = true // the prose WRAPS, never clips — this pane is for reading
        wrapStyleWord = true
        border = JBUI.Borders.empty(2, 8)
    }
    /** Cache per request id — re-selecting a request shows its response instantly, no re-fetch. */
    private val responseCache = HashMap<String, RequestResponse>()
    /** The id whose response is currently being fetched, so a slow fetch that lands after the selection
     *  moved on is dropped rather than shown under the wrong ask. */
    private var responseWanted: String? = null

    init {
        val north = JPanel(BorderLayout()).apply {
            add(toolbar(), BorderLayout.NORTH)
            add(head, BorderLayout.CENTER)
            add(desc, BorderLayout.SOUTH)
        }
        add(north, BorderLayout.NORTH)
        // List on top, Claude's response below — a draggable divider so the reader gives the reply as
        // much room as they want (or collapses it). The list keeps the majority by default.
        val responsePane = JPanel(BorderLayout()).apply {
            add(responseHead, BorderLayout.NORTH)
            add(JBScrollPane(responseText), BorderLayout.CENTER)
        }
        add(
            com.intellij.ui.OnePixelSplitter(true, 0.62f).apply {
                firstComponent = JBScrollPane(list)
                secondComponent = responsePane
            },
            BorderLayout.CENTER,
        )
        list.addListSelectionListener {
            if (it.valueIsAdjusting || syncing) return@addListSelectionListener
            service().selectedRequestId = list.selectedValue?.id
            showResponse(list.selectedValue)
        }
        // A width change re-wraps every ask, which changes every row's height — JList caches those, so
        // ask it to re-measure. Without this a narrowed pane clips text that the renderer has already
        // re-wrapped onto more lines.
        list.addComponentListener(object : java.awt.event.ComponentAdapter() {
            override fun componentResized(e: java.awt.event.ComponentEvent) {
                list.fixedCellHeight = 1
                list.fixedCellHeight = -1
            }
        })
        service().addListener(Runnable { repaint(service().requests()) })
        repaint(service().requests())
    }

    // The window's only job is picking the ask that scopes the Overview — no per-ask review actions.
    // Those live where the review happens: the Overview's Request axis on the nav bar, and its bulk
    // buttons ("Accept All in #N") once an ask is selected. The one toolbar action is Clear Scope, the
    // mirror of the VS Code window's clear button.
    private fun toolbar(): Component {
        val group = DefaultActionGroup().apply {
            add(object : AnAction("Clear Scope", "Clear the request scope — the Overview goes back to the whole session", AllIcons.Actions.Cancel) {
                override fun getActionUpdateThread() = ActionUpdateThread.EDT
                override fun update(e: AnActionEvent) {
                    e.presentation.isEnabled = service().selectedRequestId != null
                }
                override fun actionPerformed(e: AnActionEvent) {
                    list.clearSelection()
                    service().selectedRequestId = null
                }
            })
        }
        val tb = ActionManager.getInstance().createActionToolbar(ActionPlaces.TOOLWINDOW_CONTENT, group, true)
        tb.targetComponent = this
        return tb.component
    }

    /** Show the selected ask's Claude reply below the list — from the cache if seen, else fetched on a
     *  pooled thread (it can be large) and shown when it lands, unless the selection has moved on. */
    private fun showResponse(r: SessionRequest?) {
        if (r == null) {
            responseWanted = null
            responseHead.text = "Select a request to read Claude's response"
            responseText.text = ""
            return
        }
        responseCache[r.id]?.let { responseWanted = r.id; paintResponse(r, it); return }
        if (responseWanted == r.id) return // a fetch for this ask is already in flight — don't duplicate it
        responseWanted = r.id
        responseHead.text = "#${r.index} · reading Claude's response…"
        responseText.text = ""
        val session = service().currentSession() ?: return
        val workDir = project.basePath
        com.intellij.openapi.application.ApplicationManager.getApplication().executeOnPooledThread {
            val json = com.cellobservatory.observatory.core.ObservatoryCli.requestResponseJson(session, r.id, workDir)
            val resp = json?.let { com.cellobservatory.observatory.model.RequestsParser.parseResponse(it) }
                ?: RequestResponse(r.id, r.index, "", 0, 0)
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed || responseWanted != r.id) return@invokeLater // selection moved on
                responseCache[r.id] = resp
                paintResponse(r, resp)
            }
        }
    }

    private fun paintResponse(r: SessionRequest, resp: RequestResponse) {
        responseHead.text = when {
            resp.text.isBlank() -> "#${r.index} · Claude wrote no prose for this ask (it may have only run tools)"
            resp.truncated > 0L -> "#${r.index} · Claude's response · ${resp.turns} turn${if (resp.turns == 1) "" else "s"} · ${resp.truncated / 1024} KB more not shown"
            else -> "#${r.index} · Claude's response · ${resp.turns} turn${if (resp.turns == 1) "" else "s"}"
        }
        responseText.text = resp.text
        responseText.caretPosition = 0 // start at the top, not wherever the last one left it
    }

    /** Paint the list. Newest ask FIRST — it is the one the reader is still thinking about — while each
     *  row keeps its own #index, so the numbering a person counts by is never renumbered by the sort. */
    private fun repaint(res: RequestsResult?) {
        val keepId = service().selectedRequestId
        syncing = true
        try {
            model.clear()
            res?.requests?.asReversed()?.forEach { model.addElement(it) }
            last = res
            // The three states kept apart, as everywhere else: nothing read yet · the CLI answered
            // nothing · this session genuinely has no recorded ask. Only the last is an observation.
            list.emptyText.text = when {
                res != null -> "No requests recorded yet — this fills in with every prompt you send"
                !service().requestsAttempted -> "Reading this session’s requests…"
                else -> "The claude-observatory CLI on PATH did not answer `requests --json` — update it to list your requests"
            }
            val s = res?.summary
            head.text = if (s == null) "" else
                "${s.total} ask${if (s.total == 1) "" else "s"} · ${s.withEdits} with edits · ${s.edits} edit${if (s.edits == 1) "" else "s"}"
            // Re-select the scoped ask against the FRESH rows (and let it go if it vanished with a
            // session switch — a scope nothing can name must not keep filtering the Overview).
            val idx = (0 until model.size()).firstOrNull { model.get(it).id == keepId }
            if (idx != null) list.selectedIndex = idx else list.clearSelection()
            if (idx == null && keepId != null) service().selectedRequestId = null
        } finally {
            syncing = false
        }
        // The selection listener is muted during a repaint (syncing), so drive the response viewer here —
        // this also covers a panel that opened with an ask already scoped. Cheap: cache-hit or a no-op
        // while a fetch is already in flight.
        showResponse(list.selectedValue)
    }
}

/**
 * One request row: the facts it produced on one line, then THE ASK ITSELF, wrapped over as many lines
 * as it takes.
 *
 * Nothing here is clipped (user rule 2026-07-23): an ellipsis throws away the only copy of what the
 * person actually said, and the ask is the row's entire identity. Wrapping is done by giving the label
 * an explicit pixel width — a Swing HTML label only breaks lines when it has one.
 */
private class RequestRowRenderer : ListCellRenderer<SessionRequest> {
    private val facts = com.intellij.ui.SimpleColoredComponent()
    private val ask = JBLabel()
    private val panel = JPanel(BorderLayout()).apply {
        border = JBUI.Borders.empty(3, 6)
        add(facts, BorderLayout.NORTH)
        add(ask, BorderLayout.CENTER)
    }

    override fun getListCellRendererComponent(
        list: JList<out SessionRequest>, value: SessionRequest?, index: Int, selected: Boolean, hasFocus: Boolean,
    ): Component {
        val r = value ?: return panel
        facts.clear()
        facts.isOpaque = false
        val (glyph, color) = when {
            r.edits == 0 -> "○" to JBColor.GRAY
            r.pending > 0 -> "◐" to CM_PENDING
            r.undone > 0 -> "◑" to JBColor.GRAY
            else -> "●" to CM_KEPT
        }
        facts.append("$glyph ", com.intellij.ui.SimpleTextAttributes(com.intellij.ui.SimpleTextAttributes.STYLE_PLAIN, color))
        facts.append("#${r.index}  ", com.intellij.ui.SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        // core leaves endTs at 0 for the ask still being answered — say so rather than showing a
        // duration that will keep growing without explanation.
        if (r.current) facts.append("answering…  ", com.intellij.ui.SimpleTextAttributes(com.intellij.ui.SimpleTextAttributes.STYLE_ITALIC, MT_WORKING))
        if (r.edits > 0) {
            if (r.added > 0 || r.removed > 0) {
                facts.append("+${r.added}", MT_ADD)
                facts.append(" −${r.removed}  ", MT_REM)
            }
            facts.append(
                "${r.edits} edit${if (r.edits == 1) "" else "s"} · ${r.files}f · ${r.folders}fo" + if (r.pending > 0) " · ${r.pending} pending" else "",
                com.intellij.ui.SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES,
            )
        } else {
            // An ask that changed no files is normal and common — but WHY is the honest part: one that
            // never ran a tool was a question or a decision; one that ran plenty did work that simply
            // didn't land in the tree, and calling that "a question" would be wrong.
            facts.append(
                if (r.actions > 0) "no edits · ${r.actions} tool call${if (r.actions == 1) "" else "s"}" else "no edits — a question or a decision",
                com.intellij.ui.SimpleTextAttributes.GRAYED_ITALIC_ATTRIBUTES,
            )
        }
        if (r.tokens > 0) facts.append("  ${fmtTok(r.tokens)} tok", com.intellij.ui.SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        if (r.errors > 0) facts.append("  ✗ ${r.errors}", com.intellij.ui.SimpleTextAttributes(com.intellij.ui.SimpleTextAttributes.STYLE_PLAIN, MT_ERROR))
        val spawned = listOfNotNull(
            r.agents.size.takeIf { it > 0 }?.let { "$it subagent${if (it == 1) "" else "s"}" },
            r.workflows.size.takeIf { it > 0 }?.let { "$it run${if (it == 1) "" else "s"}" },
            r.tasks.takeIf { it > 0 }?.let { "$it task${if (it == 1) "" else "s"}" },
            r.processes.size.takeIf { it > 0 }?.let { "$it shell${if (it == 1) "" else "s"}" },
        )
        if (spawned.isNotEmpty()) facts.append("  ${spawned.joinToString(" · ")}", com.intellij.ui.SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
        if (r.compactions > 0) facts.append("  ⌁ ${r.compactions}", com.intellij.ui.SimpleTextAttributes(com.intellij.ui.SimpleTextAttributes.STYLE_PLAIN, MT_ATTENTION))
        if (r.durationMs > 0) facts.append("  ${if (r.current) "~" else ""}${fmtDur(r.durationMs)}", com.intellij.ui.SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)

        val w = (list.width - JBUI.scale(28)).coerceAtLeast(JBUI.scale(120))
        ask.text = "<html><body style='width:${w}px'>${escHtml(r.text.ifBlank { r.title })}</body></html>"
        ask.foreground = if (selected) UIUtil.getListSelectionForeground(true) else UIUtil.getListForeground()
        panel.background = if (selected) UIUtil.getListSelectionBackground(true) else UIUtil.getListBackground()
        panel.isOpaque = true
        facts.foreground = ask.foreground
        panel.toolTipText = buildString {
            append("<html><body style='width:420px'>")
            append(escHtml(r.text.ifBlank { r.title }))
            append("<br><br>request #${r.index}")
            if (r.current) append(" · still being answered")
            append("<br>Select to scope the Overview to this ask — its fleet, runs, tasks, shells and change map.")
            append("<br>Work counts here if this ask STARTED it, even when it finishes later.")
            append("</body></html>")
        }
        return panel
    }
}
