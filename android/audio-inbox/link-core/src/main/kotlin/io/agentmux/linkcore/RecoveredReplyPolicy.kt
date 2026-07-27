package io.agentmux.linkcore

data class RecoveredReply(
    val turnId: String,
    val createdAtMs: Long,
    val expiresAtMs: Long,
    val hasAudio: Boolean,
)

object RecoveredReplyPolicy {
    /** Historical order stays untouched; only the newest eligible audio may autoplay. */
    fun autoplayTurnId(items: List<RecoveredReply>, nowMs: Long): String? =
        items.asSequence()
            .filter { it.hasAudio && it.expiresAtMs > nowMs }
            .maxWithOrNull(compareBy<RecoveredReply> { it.createdAtMs }.thenBy { it.turnId })
            ?.turnId
}
