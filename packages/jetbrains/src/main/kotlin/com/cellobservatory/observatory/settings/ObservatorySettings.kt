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
        var session: String? = null // pinned session id to show; empty/null = auto-resolve newest
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
    private val inlineReview = JBCheckBox("Inline review overlay (lenses and line highlights in the editor)")
    private val unifiedDiff = JBCheckBox("Show edit diffs in the unified (inline) viewer instead of side-by-side")
    private var panel: JPanel? = null

    override fun getDisplayName() = "Claude Observatory"

    override fun createComponent(): JComponent {
        panel = FormBuilder.createFormBuilder()
            .addLabeledComponent("claude-observatory CLI path (blank = auto-detect):", observatoryBin, 1, false)
            .addLabeledComponent("claude CLI path for Analyze (blank = auto-detect):", claudeBin, 1, false)
            .addLabeledComponent("Claude config dir (blank = \$CLAUDE_CONFIG_DIR, then ~/.claude):", configDir, 1, false)
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
            inlineReview.isSelected != s.inlineReview ||
            unifiedDiff.isSelected != s.unifiedDiff
    }

    override fun apply() {
        val s = ObservatorySettings.instance.state
        s.observatoryBin = observatoryBin.text.ifBlank { null }
        s.claudeBin = claudeBin.text.ifBlank { null }
        s.configDir = configDir.text.ifBlank { null }
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
        inlineReview.isSelected = s.inlineReview
        unifiedDiff.isSelected = s.unifiedDiff
    }
}
