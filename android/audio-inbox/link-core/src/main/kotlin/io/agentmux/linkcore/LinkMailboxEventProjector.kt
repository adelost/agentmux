package io.agentmux.linkcore

/** Mailbox event shape shared by the direct Phone and Wear clients. */
data class LinkMailboxEvent(
    val seq: Long,
    val clientMessageId: String,
    val targetId: String,
    val state: String,
    val body: String,
    val replyBody: String,
    val lastError: String,
    val createdAtMs: Long,
    val replyAtMs: Long,
)

/**
 * Projects server truth into the same reducer actions on Phone and Wear.
 * Replaying an event page is idempotent against an already projected state.
 */
object LinkMailboxEventProjector {
    fun actions(state: LinkState, event: LinkMailboxEvent): List<LinkAction> {
        if (event.clientMessageId.isBlank() || event.targetId.isBlank()) return emptyList()
        val actions = mutableListOf<LinkAction>()
        val existing = state.turns.firstOrNull { it.turnId == event.clientMessageId }
        if (existing == null) {
            val label = state.targets.firstOrNull { it.id == event.targetId }
                ?.label
                ?.ifBlank { event.targetId }
                ?: event.targetId
            actions += LinkAction.Submit(
                LinkTurn(
                    turnId = event.clientMessageId,
                    targetId = event.targetId,
                    targetLabel = label,
                    userText = event.body.ifBlank { "Voice message" },
                    createdAtMs = event.createdAtMs.coerceAtLeast(0L),
                ),
            )
        }
        when (event.state.lowercase()) {
            "queued", "leased", "delivered" -> {
                if (existing?.deliveryPhase != DeliveryPhase.QUEUED) {
                    actions += LinkAction.Accepted(event.clientMessageId, event.body)
                }
            }
            "replied" -> {
                if (existing?.deliveryPhase != DeliveryPhase.QUEUED) {
                    actions += LinkAction.Accepted(event.clientMessageId, event.body)
                }
                if (existing?.replyText != event.replyBody ||
                    existing.replyPhase != ReplyPhase.READY
                ) {
                    actions += LinkAction.Reply(
                        event.clientMessageId,
                        event.targetId,
                        event.replyBody,
                        event.replyAtMs.takeIf { it > 0 } ?: event.createdAtMs,
                    )
                }
            }
            "failed" -> {
                if (existing?.deliveryPhase != DeliveryPhase.FAILED) {
                    actions += LinkAction.DeliveryFailed(
                        event.clientMessageId,
                        event.lastError.ifBlank {
                            event.replyBody.ifBlank { "Delivery failed" }
                        },
                    )
                }
            }
        }
        return actions
    }
}
