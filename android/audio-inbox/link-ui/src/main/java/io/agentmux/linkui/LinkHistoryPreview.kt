package io.agentmux.linkui

import io.agentmux.linkcore.*

/** Explicit qa_state=active/qa_case=history fixture. Hosts guard entry with
 * BuildConfig.DEBUG; there is no authenticated sender or server history here. */
fun LinkState.withHistoryPreview(): LinkState {
    val latest = turns.last()
    val older = latest.copy(
        turnId = "qa-history-older",
        userText = "Show the earlier plan",
        replyText = "Here is the earlier plan.\n\n" +
            "Keep the watch easy to read. Messages belong to the chosen recipient.\n\n".repeat(10) +
            "End of the earlier reply.",
        createdAtMs = latest.createdAtMs - 120_000,
        playbackPhase = PlaybackPhase.STOPPED,
    )
    return copy(turns = listOf(older, latest.copy(
        turnId = "qa-history-voice", userText = "", replyText = "",
        createdAtMs = latest.createdAtMs - 60_000, replyPhase = ReplyPhase.THINKING,
    ), latest), activePlaybackTurnId = null)
}
