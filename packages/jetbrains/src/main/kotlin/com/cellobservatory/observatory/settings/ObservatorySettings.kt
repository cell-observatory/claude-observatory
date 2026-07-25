package com.cellobservatory.observatory.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBTextField
import com.intellij.util.ui.FormBuilder
import javax.swing.JComponent
import javax.swing.JPanel

@Service
@State(name = "ClaudeObservatorySettings", storages = [Storage("claude-observatory.xml")])
class ObservatorySettings : PersistentStateComponent<ObservatorySettings.State> {
    class State {
        var observatoryBin: String? = null // path to the claude-observatory CLI; empty = auto-detect
        var claudeBin: String? = null // path to the claude CLI (opt-in Analyze); empty = auto-detect
        var configDir: String? = null // CLAUDE_CONFIG_DIR override; empty = env var, then ~/.claude
        var inlineReview: Boolean = true // inline editor overlay (lenses + line highlights)
        var unifiedDiff: Boolean = true // open edit diffs in the unified (inline) viewer, not side-by-side
        var session: String? = null

        /** Guided tour: docked into a tool window (the default), or floating in a dialog of its own.
         *  A person's preference about their own screen, so it is remembered rather than re-asked. */
        var tourDocked: Boolean = true

        // --- the first-run / post-update demo offer -------------------------------------------------
        // Application-level, like everything else here: declining silences it in EVERY project, which is
        // what "never ask" has to mean for it to be worth offering.
        /** The plugin version this reader was last offered the demo for. */
        var demoOfferLastSeenVersion: String? = null
        /** Declined for good. */
        var demoOfferNever: Boolean = false
        /** Set on the first activation ever, so an empty version stamp can tell an INSTALL from an update. */
        var everRan: Boolean = false
        // The Overview's Active-only toggle. ON by default (0.8.8): the panel's job is work still awaiting
        // review, and a session's finished work otherwise buries it. Persisted so the toggle survives a
        // panel hide, a project reopen, and an IDE restart — a filter that silently resets is a filter the
        // reader has to re-check every time.
        var overviewActiveOnly: Boolean = true
        // Where the Overview's master/detail divider sits, as the master's share of the panel — one value
        // per layout, because a good nav WIDTH side by side is not a good nav HEIGHT stacked. Persisted for
        // the same reason the toggle above is: a divider that resets is one the reader re-drags every time.
        var overviewSplitWide: Float = 0.25f
        var overviewSplitNarrow: Float = 0.38f
    }

    private var myState = State()
    override fun getState(): State = myState
    override fun loadState(state: State) {
        myState = state
    }

    companion object {
        val instance: ObservatorySettings
            get() = ApplicationManager.getApplication().getService(ObservatorySettings::class.java)
    }
}

class ObservatoryConfigurable : Configurable {
    private val observatoryBin = JBTextField()
    private val claudeBin = JBTextField()
    private val configDir = JBTextField()
    private val session = JBTextField()
    private val inlineReview = JBCheckBox("Inline review overlay (lenses and line highlights in the editor)")
    private val unifiedDiff = JBCheckBox("Show edit diffs in the unified (inline) viewer instead of side-by-side")
    private var panel: JPanel? = null

    override fun getDisplayName() = "Claude Observatory"

    override fun createComponent(): JComponent {
        panel = FormBuilder.createFormBuilder()
            .addLabeledComponent("claude-observatory CLI path (blank = auto-detect):", observatoryBin, 1, false)
            .addLabeledComponent("claude CLI path for Analyze (blank = auto-detect):", claudeBin, 1, false)
            .addLabeledComponent("Claude config dir (blank = \$CLAUDE_CONFIG_DIR, then ~/.claude):", configDir, 1, false)
            .addLabeledComponent("Pinned session (blank = auto-resolve newest):", session, 1, false)
            .addComponent(inlineReview)
            .addComponent(unifiedDiff)
            .addComponentFillVertically(JPanel(), 0)
            .panel
        reset()
        return panel!!
    }

    override fun isModified(): Boolean {
        val s = ObservatorySettings.instance.state
        return observatoryBin.text != (s.observatoryBin ?: "") ||
            claudeBin.text != (s.claudeBin ?: "") ||
            configDir.text != (s.configDir ?: "") ||
            session.text != (s.session ?: "") ||
            inlineReview.isSelected != s.inlineReview ||
            unifiedDiff.isSelected != s.unifiedDiff
    }

    override fun apply() {
        val s = ObservatorySettings.instance.state
        s.observatoryBin = observatoryBin.text.ifBlank { null }
        s.claudeBin = claudeBin.text.ifBlank { null }
        s.configDir = configDir.text.ifBlank { null }
        s.session = session.text.ifBlank { null }
        s.inlineReview = inlineReview.isSelected
        s.unifiedDiff = unifiedDiff.isSelected
        // Re-render every open project so a config-dir change or overlay toggle applies immediately.
        for (p in com.intellij.openapi.project.ProjectManager.getInstance().openProjects) {
            com.cellobservatory.observatory.services.ObservatoryService.getInstance(p).refresh()
        }
    }

    override fun reset() {
        val s = ObservatorySettings.instance.state
        observatoryBin.text = s.observatoryBin ?: ""
        claudeBin.text = s.claudeBin ?: ""
        configDir.text = s.configDir ?: ""
        session.text = s.session ?: ""
        inlineReview.isSelected = s.inlineReview
        unifiedDiff.isSelected = s.unifiedDiff
    }
}
