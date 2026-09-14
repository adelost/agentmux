package io.agentmux.linkui

import com.adelost.designkit.ui.CircleAccent

/** Accents that name a sender. Grey means muted, orange and red mean attention, so none of those name a pane. */
private val SENDER_ACCENTS = listOf(
    CircleAccent.SKY, CircleAccent.SUN, CircleAccent.VIOLET, CircleAccent.POSITIVE,
    CircleAccent.RAIN, CircleAccent.ACHIEVEMENT, CircleAccent.COLD,
)

/** One stable watch accent per recipient: the same pane has the same colour in TALK TO and in the thread. */
fun linkSenderAccent(recipientId: String): CircleAccent =
    SENDER_ACCENTS[Math.floorMod(recipientId.hashCode(), SENDER_ACCENTS.size)]
