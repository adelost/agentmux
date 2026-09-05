package io.agentmux.audioinbox

/** The submitted text associated with one durably accepted turn. */
internal data class AcceptedDraft(val turnId: String, val draft: String)

/**
 * WHAT: Tracks which exact local draft revision awaits durable acceptance.
 * WHY: Keeps an older acceptance from clearing newer text with identical content.
 */
internal data class ComposerDraft(
    val text: String = "",
    val editRevision: Long = 0,
    val pendingTurnId: String? = null,
    val pendingRevision: Long = -1,
) {
    fun edited(value: String): ComposerDraft =
        if (value.length > io.agentmux.linkcore.LinkHistoryPolicy.MAX_COMPOSE_CHARS) this
        else copy(text = value, editRevision = editRevision + 1)

    fun submitted(turnId: String): ComposerDraft =
        copy(pendingTurnId = turnId, pendingRevision = editRevision)

    fun accepted(turnId: String, acceptedDraft: String): ComposerDraft {
        val exact = pendingTurnId == turnId &&
            pendingRevision == editRevision &&
            text == acceptedDraft
        return if (exact) ComposerDraft(editRevision = editRevision) else this
    }
}
