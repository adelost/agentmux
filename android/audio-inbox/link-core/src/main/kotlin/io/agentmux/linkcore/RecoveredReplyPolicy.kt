package io.agentmux.linkcore

/**
 * WHAT: Describes one recovered reply considered for reconnect autoplay.
 * WHY: Keeps recovery decisions independent from Android playback objects.
 */
data class RecoveredReply(
    val turnId: String,
    val createdAtMs: Long,
    val expiresAtMs: Long,
    val hasAudio: Boolean,
)

/**
 * WHAT: Resolves at most the newest eligible recovered direct reply for autoplay.
 * WHY: Keeps reconnect from replaying an entire historical backlog.
 */
object RecoveredReplyPolicy {
    /** Historical order stays untouched; only the newest eligible audio may autoplay. */
    fun autoplayTurnId(items: List<RecoveredReply>, nowMs: Long): String? =
        items.asSequence()
            .filter { it.hasAudio && it.expiresAtMs > nowMs }
            .maxWithOrNull(compareBy<RecoveredReply> { it.createdAtMs }.thenBy { it.turnId })
            ?.turnId
}
