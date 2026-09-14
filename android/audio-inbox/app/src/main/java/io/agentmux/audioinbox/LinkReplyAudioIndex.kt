package io.agentmux.audioinbox

import android.media.MediaMetadataRetriever
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkui.LinkReplyAudio
import io.agentmux.linkui.readAloudText
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * WHAT: Tells the conversation which replies still have saved speech, and how long it is.
 * WHY: After a restart a reply must say "fresh", "expired" or "not made yet" instead of failing on tap.
 */
internal class LinkReplyAudioIndex(
    private val cache: ReplyAudioCache,
    private val durationOf: (File) -> Long = ::mediaDurationMs,
) {
    private val durations = ConcurrentHashMap<String, Long>()

    fun audioFor(turn: LinkTurn, target: ConversationTarget?): LinkReplyAudio {
        if (turn.replyText.isBlank() || target == null) return LinkReplyAudio.NotGenerated
        val saved = cache.saved(target.serverUrl, turn.readAloudText())
        return when {
            saved != null -> LinkReplyAudio.Saved(durations.getOrPut(saved.name) { durationOf(saved) })
            turn.playbackPhase in HEARD -> LinkReplyAudio.Expired(regenerable = target.kind != ConversationTarget.Kind.PUBLIC)
            else -> LinkReplyAudio.NotGenerated
        }
    }

    private companion object {
        val HEARD = setOf(PlaybackPhase.PLAYED, PlaybackPhase.STOPPED)
    }
}

private fun mediaDurationMs(file: File): Long = runCatching {
    MediaMetadataRetriever().use { it.setDataSource(file.absolutePath); it.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong() }
}.getOrNull() ?: 0L
