package com.cellobservatory.observatory.model

/**
 * How the Overview's left-nav members fold into side-by-side groups.
 *
 * The five nav members answer two different questions, and reading one usually means reading its partner:
 * WHICH conversation (Sessions ⟷ Fleet) and WHAT it is doing (Workflows ⟷ Tasks ⟷ Processes). Grouped mode
 * renders each group's members as columns of one tab so the pair is on screen together, at the cost of
 * width — which is why it is a toggle and not the default.
 *
 * Kept as pure data here, away from the panel, for one reason: the member names are also the names core's
 * guided tour uses, and every tab title write in the panel resolves through them. A wrong answer from this
 * function relabels the wrong column, silently, on whichever repaint runs next.
 */
object NavGrouping {

    const val SESSIONS = "sessions"
    const val FLEET = "fleet"
    const val WORKFLOWS = "workflows"
    const val TASKS = "tasks"
    const val PROCESSES = "processes"

    const val SESSIONS_FLEET = "sessions-fleet"
    const val RUNS = "workflows-tasks-processes"

    /** Group key → its members, in shipped order. Sessions leads its group for the same reason it leads
     *  the plain tab strip: which session you are reviewing precedes every other question. */
    val GROUPS: Map<String, List<String>> = linkedMapOf(
        SESSIONS_FLEET to listOf(SESSIONS, FLEET),
        RUNS to listOf(WORKFLOWS, TASKS, PROCESSES),
    )

    /** The tab title each group carries. Members are separated by the same middle dot the product uses
     *  everywhere else for "and also". */
    val GROUP_TITLES: Map<String, String> = mapOf(
        SESSIONS_FLEET to "Sessions · Fleet",
        RUNS to "Workflows · Tasks · Processes",
    )

    /**
     * Which TAB hosts [member]: itself when the nav is ungrouped, its group when it is grouped.
     *
     * An unknown member maps to itself in both modes — the caller then finds no such tab and does nothing,
     * which is the same "unknown name rings nothing" contract the tour anchors use.
     */
    fun groupOf(member: String, grouped: Boolean): String {
        if (!grouped) return member
        return GROUPS.entries.firstOrNull { member in it.value }?.key ?: member
    }

    // --- The Timeline window's own grouping (0.10.0) -----------------------------------------------
    // Its three surfaces answer ONE question between them — what happened, in order — so grouped mode
    // puts all three on screen at once rather than pairing two of them: the ask on the left, and what
    // came back from it (observations, then the tool calls themselves) to its right. The Overview's
    // grouping is a separate toggle for a separate window; nothing here reads its setting.

    const val PROMPTS = "prompts"
    const val OBSERVATIONS = "observations"
    const val ACTIONS = "actions"

    /** The group key the Timeline's remembered column widths are stored under. */
    const val TIMELINE = "timeline"

    /** The Timeline's members, in shipped order — the same order their tabs carry ungrouped. */
    val TIMELINE_MEMBERS: List<String> = listOf(PROMPTS, OBSERVATIONS, ACTIONS)

    val TIMELINE_TITLES: Map<String, String> = mapOf(
        PROMPTS to "Prompts",
        OBSERVATIONS to "Observations",
        ACTIONS to "Actions",
    )
}
