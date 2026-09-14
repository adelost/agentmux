package io.agentmux.audioinbox

import android.content.Context
import android.media.MediaMetadataRetriever
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.linkui.LinkReplyAudio
import io.agentmux.linkui.readAloudText
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * WHAT: Tells the conversation which replies still have saved speech, and how long it is, and saves a reply's speech as soon as it lands.
 * WHY: After a restart a reply must say "fresh", "expired" or "not made yet" instead of failing on tap.
 *      Mattias 2026-09-14: "Man borde ju ha laddat ner ljudfilen sen innan så att man har svaret." READ ALOUD plays a saved file.
 */
internal class LinkReplyAudioIndex(
    private val cache: ReplyAudioCache,
    private val makeSpeech: (server: String, text: String) -> File,
    private val background: Executor = Executors.newSingleThreadExecutor(),
    private val durationOf: (File) -> Long = ::mediaDurationMs,
) : AutoCloseable {
    private val durations = ConcurrentHashMap<String, Long>()
    private val savedCount = MutableStateFlow(0)

    /** Counts speech saved ahead of a tap, so rows re-read their audio when it arrives. */
    val saved: StateFlow<Int> = savedCount.asStateFlow()

    fun audioFor(turn: LinkTurn, target: ConversationTarget?): LinkReplyAudio {
        if (turn.replyText.isBlank() || target == null) return LinkReplyAudio.NotGenerated
        val saved = cache.saved(target.serverUrl, turn.readAloudText())
        return when {
            saved != null -> LinkReplyAudio.Saved(durations.getOrPut(saved.name) { durationOf(saved) })
            turn.playbackPhase in HEARD -> LinkReplyAudio.Expired(regenerable = target.kind != ConversationTarget.Kind.PUBLIC)
            else -> LinkReplyAudio.NotGenerated
        }
    }

    /** Makes and keeps the speech for a reply that just landed. A failure leaves it unsaved; a tap asks again and shows why. */
    fun prepare(turn: LinkTurn, target: ConversationTarget?) {
        val text = turn.readAloudText()
        if (target == null || !DirectReplyLoader.canReadAloud(text, target.serverUrl)) return
        background.execute {
            runCatching { cache.keep(target.serverUrl, text) { makeSpeech(target.serverUrl, text) } }
                .onSuccess { savedCount.update { it + 1 } }
        }
    }

    override fun close() {
        (background as? ExecutorService)?.shutdownNow()
    }

    companion object {
        private val HEARD = setOf(PlaybackPhase.PLAYED, PlaybackPhase.STOPPED)

        /** The phone's index: speech comes from the reply's own server and lands in the process-wide cache. */
        fun onDevice(context: Context, consumerId: String) = LinkReplyAudioIndex(DirectReplyLoader.replyAudio(context), { server, text ->
            AudioInboxHttpClient(server, consumerId).fetchTts(context.cacheDir, "prefetch-${UUID.randomUUID()}", text)
        })
    }
}

/** The reply an action just made ready, or null when nothing new landed (a repeated reply must not fetch again). */
internal fun landedReply(before: LinkState, after: LinkState, action: LinkAction): LinkTurn? {
    if (action !is LinkAction.Reply || before.turns.any { it.turnId == action.turnId && it.replyPhase == ReplyPhase.READY }) return null
    return after.turns.firstOrNull { it.turnId == action.turnId && it.replyPhase == ReplyPhase.READY }
}

private fun mediaDurationMs(file: File): Long = runCatching {
    MediaMetadataRetriever().use { it.setDataSource(file.absolutePath); it.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLong() }
}.getOrNull() ?: 0L
