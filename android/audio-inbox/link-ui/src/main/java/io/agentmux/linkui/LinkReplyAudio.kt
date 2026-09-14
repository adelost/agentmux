package io.agentmux.linkui

import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.wakeword.spokenReply

/** Spoken after a summarized reply, so a listener knows the rest is on screen. */
const val READ_ALOUD_MORE_ON_SCREEN = "Hela svaret finns i Link."

/** The one text Link turns into speech for a reply, by tap or hands-free: no markup, long replies summarized. */
fun LinkTurn.readAloudText(): String = spokenReply(replyText, READ_ALOUD_MORE_ON_SCREEN).text

/** What a device that keeps generated speech can offer for one reply. */
sealed interface LinkReplyAudio {
    /** Never generated here; tapping reads it aloud. Hosts with native speech always use this. */
    data object NotGenerated : LinkReplyAudio

    /** Saved on this device and playable offline. */
    data class Saved(val durationMs: Long) : LinkReplyAudio

    /** Was generated, but only the ten newest are kept. */
    data class Expired(val regenerable: Boolean) : LinkReplyAudio
}

/** The READ ALOUD row for a reply: fresh audio is loud, pruned audio is grey, only real failures ask for a retry. */
data class LinkReadAloudRow(val title: String, val sub: String, val tappable: Boolean, val muted: Boolean)

fun linkReadAloudRow(turn: LinkTurn, audio: LinkReplyAudio): LinkReadAloudRow = when {
    turn.playbackPhase == PlaybackPhase.FAILED ->
        LinkReadAloudRow("READ ALOUD", if (turn.playbackError.isBlank()) "Audio unavailable · tap to retry" else "Tap to retry", true, false)
    audio is LinkReplyAudio.Saved -> LinkReadAloudRow("READ ALOUD", clockDuration(audio.durationMs), true, false)
    audio is LinkReplyAudio.Expired && audio.regenerable -> LinkReadAloudRow("AUDIO EXPIRED", "Tap to regenerate", true, true)
    audio is LinkReplyAudio.Expired -> LinkReadAloudRow("AUDIO EXPIRED", "", false, true)
    else -> LinkReadAloudRow("READ ALOUD", "", true, false)
}

private fun clockDuration(ms: Long): String {
    if (ms <= 0) return ""
    val seconds = (ms + 500) / 1000
    return "%d:%02d".format(seconds / 60, seconds % 60)
}
