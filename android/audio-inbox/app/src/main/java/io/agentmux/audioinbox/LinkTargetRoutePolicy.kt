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
        // The authenticated mailbox durably queues for an offline connector;
        // a dead private route cannot. Presence is not acceptance.
        publicLink != null -> publicLink
        else -> tailnet
    }

    fun connectionDetail(
        hasTailnetRoute: Boolean,
        hasPublicFallback: Boolean,
    ): String = when {
        hasTailnetRoute && hasPublicFallback ->
            "Connected via Tailscale · Public fallback ready"
        hasTailnetRoute -> "Connected via Tailscale"
        hasPublicFallback -> "Connected via Public Link"
        else -> "Link unavailable"
    }
}
