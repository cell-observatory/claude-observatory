package com.cellobservatory.observatory.ui

import com.intellij.icons.AllIcons
import com.intellij.notification.NotificationType
import com.intellij.openapi.project.Project
import javax.swing.Icon

/**
 * The demo-mode verbs, and the state each one belongs to. The Overview's nav bar is the only panel that
 * offers them, so this is not shared between callers today — it is here to be TESTABLE. Every panel in
 * this plugin needs a Project to construct, which puts its toolbars out of reach of a unit test; a plain
 * list does not, so the invariants below can actually be asserted rather than merely intended.
 *
 * [wantDemo] is the state the verb belongs to: Start applies only before a demo exists, and Restart,
 * Guided Tour and Exit only once one does. A toolbar shows each verb exactly when that matches.
 */
object DemoVerbs {

    data class Verb(val text: String, val icon: Icon, val wantDemo: Boolean, val run: (Project) -> Unit)

    val ALL: List<Verb> = listOf(
        Verb("Start Demo Mode", AllIcons.Actions.Execute, wantDemo = false) { ReviewOps.startDemo(it) },
        Verb("Restart Demo", AllIcons.Actions.Restart, wantDemo = true) { ReviewOps.startDemo(it) },
        Verb("Guided Tour", AllIcons.Actions.Preview, wantDemo = true) { project ->
            com.cellobservatory.observatory.ui.tour.TourController.getInstance(project)
                .start { msg -> ReviewOps.notify(project, msg, NotificationType.WARNING) }
        },
        Verb("Exit Demo Mode", AllIcons.Actions.Cancel, wantDemo = true) { ReviewOps.exitDemo(it) },
    )
}
