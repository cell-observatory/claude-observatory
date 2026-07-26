package com.cellobservatory.observatory.model

/**
 * The mirror of core's `demoActionState` — whether a guided-tour `wait` step has been answered.
 *
 * It lives here, pure and away from the controller, for one reason: it is a SECOND implementation of a
 * rule core already owns, and the only thing stopping the two editors from disagreeing about what "done"
 * means is that this file says the same thing core's does. A rule that can drift needs a test that fails
 * when it drifts, and a function that needs a Project to call cannot have one.
 *
 * Counts are taken before the step is armed and again on every store change; the step is satisfied when
 * the relevant count has gone UP. "Vacated" is the other way a step ends: there is nothing left to do it
 * to, which must not be mistaken for a reason to keep waiting.
 */
object TourVerdict {
    const val WAITING = "waiting"
    const val SATISFIED = "satisfied"
    const val VACATED = "vacated"

    /** The kinds a `wait` step can carry. Anything else is a newer CLI's, and waits. */
    private val KEEP_KINDS = setOf("keep-edit", "keep-prompt", "keep-task")

    fun of(kind: String, beforeKept: Int, beforeUndone: Int, kept: Int, undone: Int, pending: Int, total: Int): String = when {
        // The records were cleared under us — a fully reviewed demo drops its own log, and that empty
        // log IS the answer rather than a reason to wait forever.
        total == 0 -> VACATED
        kind == "undo-edit" -> if (undone > beforeUndone) SATISFIED else WAITING
        // A kind this build has never heard of waits, exactly as core does. Falling through to the keep
        // arms would report "satisfied" on any unrelated accept.
        kind !in KEEP_KINDS -> WAITING
        kept > beforeKept -> SATISFIED
        // All resolved but still recorded: there is no edit left to accept, so waiting would hang.
        pending == 0 -> VACATED
        else -> WAITING
    }
}
