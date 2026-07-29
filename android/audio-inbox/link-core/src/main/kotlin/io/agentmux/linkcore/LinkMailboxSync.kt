package io.agentmux.linkcore

/** The deterministic result of one mailbox page on either Android host. */
data class LinkMailboxSyncResult(
    val actions: List<LinkAction>,
    val afterSeq: Long,
    val repliedTurnIds: List<String>,
    val heartbeatStates: Map<String, Boolean>,
)

/**
 * Reduces one ordered server page without owning scheduling or Android state.
 *
 * Phone and Wear therefore share event projection, target availability, and
 * cursor advancement while retaining their own polling and playback hosts.
 */
object LinkMailboxSync {
    fun apply(
        initial: LinkState,
        afterSeq: Long,
        events: List<LinkMailboxEvent>,
        heartbeatStates: Map<String, Boolean>,
    ): LinkMailboxSyncResult {
        var state = initial
        val actions = mutableListOf<LinkAction>()
        val replied = mutableListOf<String>()
        var nextSeq = afterSeq
        events
            .asSequence()
            .filter { it.seq > afterSeq }
            .sortedBy(LinkMailboxEvent::seq)
            .forEach { event ->
                val projected = LinkMailboxEventProjector.actions(state, event)
                projected.forEach { action ->
                    actions += action
                    state = LinkReducer.reduce(state, action)
                }
                nextSeq = maxOf(nextSeq, event.seq)
                if (event.state.equals("replied", ignoreCase = true) &&
                    event.replyBody.isNotBlank()
                ) {
                    replied += event.clientMessageId
                }
            }
        if (state.targets.isNotEmpty()) {
            val targets = state.targets.map { target ->
                target.copy(available = heartbeatStates[target.id] ?: false)
            }
            val targetAction = LinkAction.Targets(targets)
            actions += targetAction
        }
        return LinkMailboxSyncResult(
            actions = actions,
            afterSeq = nextSeq,
            repliedTurnIds = replied.distinct(),
            heartbeatStates = heartbeatStates,
        )
    }
}
