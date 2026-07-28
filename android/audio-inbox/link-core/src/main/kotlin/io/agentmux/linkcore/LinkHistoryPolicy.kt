package io.agentmux.linkcore

/**
 * Link intentionally keeps a small local conversation window. There is no
 * server history endpoint, so the UI must never imply that evicted turns can
 * be fetched later.
 */
object LinkHistoryPolicy {
    const val MAX_LOCAL_TURNS = 50

    fun retain(turns: List<LinkTurn>): List<LinkTurn> =
        turns.takeLast(MAX_LOCAL_TURNS)
}
