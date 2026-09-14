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

/** The picture on a reply's read-aloud control: play the speech, or make it again. */
enum class ReadAloudIcon { SPEAKER, REFRESH }

/** A reply's read-aloud control is a picture, never a label: at most the audio's length beside it. */
data class LinkReadAloudRow(val icon: ReadAloudIcon, val length: String, val tappable: Boolean, val muted: Boolean)

fun linkReadAloudRow(turn: LinkTurn, audio: LinkReplyAudio): LinkReadAloudRow = when {
    turn.playbackPhase == PlaybackPhase.FAILED -> LinkReadAloudRow(ReadAloudIcon.REFRESH, "", true, false)
    audio is LinkReplyAudio.Saved -> LinkReadAloudRow(ReadAloudIcon.SPEAKER, clockDuration(audio.durationMs), true, false)
    audio is LinkReplyAudio.Expired && audio.regenerable -> LinkReadAloudRow(ReadAloudIcon.REFRESH, "", true, true)
    audio is LinkReplyAudio.Expired -> LinkReadAloudRow(ReadAloudIcon.SPEAKER, "", false, true)
    else -> LinkReadAloudRow(ReadAloudIcon.SPEAKER, "", true, false)
}

private fun clockDuration(ms: Long): String {
    if (ms <= 0) return ""
    val seconds = (ms + 500) / 1000
    return "%d:%02d".format(seconds / 60, seconds % 60)
}
