package io.agentmux.audioinbox

/**
 * Chooses the least exposed usable route for one logical Link target.
 *
 * Private Tailnet transport is the normal route. Public Link remains a
 * deliberate, authenticated fallback for use outside the tailnet.
 */
internal object LinkTargetRoutePolicy {
    fun choose(
        tailnet: ConversationTarget?,
        publicLink: ConversationTarget?,
    ): ConversationTarget? = when {
        tailnet?.available() == true -> tailnet
        publicLink?.available() == true -> publicLink
        tailnet != null -> tailnet
        else -> publicLink
    }
}
