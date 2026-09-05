package io.agentmux.linkcore

/**
 * Link intentionally keeps a small local conversation window. There is no
 * server history endpoint, so the UI must never imply that evicted turns can
 * be fetched later.
 */
object LinkHistoryPolicy {
    const val MAX_LOCAL_TURNS = 50
    const val MAX_MESSAGE_CHARS = 12_000
    const val MAX_HISTORY_CHARS = 256_000
    const val MAX_COMPOSE_CHARS = 4_000
    const val SHORTENED = "\n\n[Message shortened on this device]"

    /** UTF-16 character budgets, not an estimate of the whole process heap. */
    fun retain(turns: List<LinkTurn>): List<LinkTurn> {
        var remaining = MAX_HISTORY_CHARS.toLong()
        val kept = ArrayList<LinkTurn>()
        for (turn in turns.takeLast(MAX_LOCAL_TURNS).asReversed()) {
            val bounded = turn.copy(
                userText = boundedText(turn.userText),
                replyText = boundedText(turn.replyText),
                targetLabel = boundedText(turn.targetLabel, 256),
                respondingTarget = boundedText(turn.respondingTarget, 256),
                deliveryError = boundedText(turn.deliveryError, 512),
                replyError = boundedText(turn.replyError, 512),
                playbackError = boundedText(turn.playbackError, 512),
            )
            val size = textSize(bounded)
            if (size > remaining) break // Evict oldest whole exchanges, never reassign IDs.
            remaining -= size
            kept += if (bounded == turn) turn else bounded
        }
        return kept.asReversed()
    }

    fun boundedText(text: String, maxChars: Int = MAX_MESSAGE_CHARS): String {
        require(maxChars >= SHORTENED.length)
        if (text.length <= maxChars) return text
        var end = maxChars - SHORTENED.length
        if (end > 0 && text[end - 1].isHighSurrogate()) end--
        return text.take(end) + SHORTENED
    }

    fun textSize(turn: LinkTurn): Long = with(turn) {
        turnId.length.toLong() + targetId.length + targetLabel.length + userText.length +
            replyText.length + respondingTarget.length + deliveryError.length +
            replyError.length + playbackError.length
    }
}
