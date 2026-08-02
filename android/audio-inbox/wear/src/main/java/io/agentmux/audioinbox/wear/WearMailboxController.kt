package io.agentmux.audioinbox.wear

import android.content.Context
import io.agentmux.audioinbox.KeystoreSessionStore
import io.agentmux.audioinbox.LinkSessionCredentials
import io.agentmux.audioinbox.PublicLinkClient
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkMailboxSync
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkStateLedger
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

internal class WearMailboxController(
    context: Context,
) : AutoCloseable {
    private val store = KeystoreSessionStore(
        context.getSharedPreferences("link-wear-session", Context.MODE_PRIVATE),
    )
    private val ledger = LinkStateLedger(LinkState()) { }
    private val work = Executors.newScheduledThreadPool(2)
    private val recorder = WearVoiceRecorder(context.applicationContext)
    private val generation = AtomicLong()
    private val spokenTurns = mutableSetOf<String>()
    private var polling: ScheduledFuture<*>? = null
    private var client: PublicLinkClient? = null
    private var afterSeq = 0L
    private var catalogRefreshAtMs = 0L
    private var sessionFingerprint = ""
    private val tts = WearTtsPlayer(
        context,
        object : WearTtsPlayer.Listener {
            override fun onStarted(turnId: String) =
                dispatch(LinkAction.Playback(turnId, PlaybackPhase.PLAYING))

            override fun onCompleted(turnId: String) =
                dispatch(LinkAction.Playback(turnId, PlaybackPhase.PLAYED))

            override fun onFailed(turnId: String, detail: String) =
                dispatch(LinkAction.PlaybackFailed(turnId, detail))
        },
    )

    val state = ledger.state

    fun start() = reloadSession()

    @Synchronized
    fun reloadSession() {
        val currentGeneration = generation.incrementAndGet()
        polling?.cancel(true)
        polling = null
        afterSeq = 0
        catalogRefreshAtMs = 0
        recorder.cancel()
        tts.stop()
        val credentials = store.credentials()
        val nextFingerprint = credentials?.let {
            "${it.identityId()}:${it.session().takeLast(12)}"
        }.orEmpty()
        if (nextFingerprint != sessionFingerprint) {
            sessionFingerprint = nextFingerprint
            spokenTurns.clear()
            dispatch(LinkAction.ResetSession)
        }
        if (credentials == null) {
            client = null
            dispatch(LinkAction.Targets(emptyList()))
            dispatch(
                LinkAction.Connection(
                    ConnectionState.CONFIGURATION_REQUIRED,
                    "LOGGA IN PÅ TELEFONEN",
                    System.currentTimeMillis(),
                ),
            )
            return
        }
        client = PublicLinkClient(credentials.baseUrl(), credentials.session())
        dispatch(
            LinkAction.Connection(
                ConnectionState.CONNECTING,
                "ANSLUTER TILL LINK",
                System.currentTimeMillis(),
            ),
        )
        polling = work.scheduleWithFixedDelay(
            { sync(currentGeneration, credentials) },
            0,
            POLL_SECONDS,
            TimeUnit.SECONDS,
        )
    }

    fun selectTarget(id: String) = dispatch(LinkAction.SelectTarget(id))

    fun beginCapture(): Boolean {
        val selected = selectedTarget() ?: return false
        if (!selected.acceptsMessages) return false
        val capture = recorder.begin()
        if (capture == null) {
            dispatch(LinkAction.Capture(CapturePhase.FAILED))
            return false
        }
        dispatch(LinkAction.Capture(CapturePhase.LISTENING, capture.startedAtMs))
        return true
    }

    fun releaseCapture() {
        val capture = recorder.release()
        if (capture == null) {
            dispatch(LinkAction.Capture(CapturePhase.FAILED))
            return
        }
        val target = selectedTarget()
        val mailbox = client
        if (target == null || mailbox == null) {
            capture.file.delete()
            dispatch(LinkAction.Capture(CapturePhase.FAILED))
            return
        }
        dispatch(LinkAction.Capture(CapturePhase.FINALIZING))
        dispatch(
            LinkAction.Submit(
                LinkTurn(
                    turnId = capture.turnId,
                    targetId = target.id,
                    targetLabel = target.label,
                    userText = "Voice message…",
                    createdAtMs = capture.startedAtMs,
                ),
            ),
        )
        work.execute {
            runCatching {
                mailbox.sendVoice(capture.turnId, target.id, capture.file)
            }.onSuccess {
                dispatch(LinkAction.Accepted(capture.turnId, "Voice message"))
                dispatch(LinkAction.Capture(CapturePhase.IDLE))
            }.onFailure { error ->
                dispatch(LinkAction.DeliveryFailed(capture.turnId, safe(error)))
                dispatch(LinkAction.Capture(CapturePhase.FAILED))
            }
            capture.file.delete()
        }
    }

    fun cancelCapture() {
        recorder.cancel()
        dispatch(LinkAction.Capture(CapturePhase.IDLE))
    }

    fun recordedBytes(): Long = recorder.currentBytes()
    fun recordedLevel(): Float = recorder.currentLevel()

    fun playLatest() {
        val turn = ledger.value.turns.lastOrNull { it.replyText.isNotBlank() } ?: return
        playTurn(turn.turnId)
    }

    private fun playTurn(turnId: String) {
        val turn = ledger.value.turns.firstOrNull { it.turnId == turnId } ?: return
        dispatch(LinkAction.Playback(turn.turnId, PlaybackPhase.QUEUED))
        tts.play(turn.turnId, turn.replyText)
    }

    fun stopPlayback() {
        val turnId = ledger.value.activePlaybackTurnId
            ?: ledger.value.turns.lastOrNull { it.replyText.isNotBlank() }?.turnId
            ?: return
        tts.stop()
        dispatch(LinkAction.Playback(turnId, PlaybackPhase.STOPPED))
    }

    private fun sync(expectedGeneration: Long, credentials: LinkSessionCredentials) {
        if (generation.get() != expectedGeneration) return
        val mailbox = client ?: return
        try {
            val now = System.currentTimeMillis()
            if (now >= catalogRefreshAtMs) {
                val catalog = mailbox.targetCatalog()
                if (generation.get() != expectedGeneration) return
                dispatch(
                    LinkAction.Targets(
                        catalog.targets.map {
                            LinkTarget(
                                id = it.id,
                                label = it.label,
                                available = it.online,
                                acceptsMessages = true,
                            )
                        },
                    ),
                )
                catalogRefreshAtMs = now + CATALOG_REFRESH_MS
            }
            val page = mailbox.events(afterSeq)
            if (generation.get() != expectedGeneration) return
            val result = LinkMailboxSync.apply(
                initial = ledger.value,
                afterSeq = afterSeq,
                events = page.events.map(PublicLinkClient.LinkEvent::asDomainEvent),
                heartbeatStates = page.heartbeats,
            )
            afterSeq = result.afterSeq
            result.actions.forEach(::dispatch)
            val newReplies = page.events.filter { event ->
                event.clientMessageId in result.repliedTurnIds &&
                    spokenTurns.add(event.clientMessageId)
            }
            newReplies.lastOrNull {
                it.replyAtMs >= now - RECOVERED_TTS_TTL_MS
            }?.let { playTurn(it.clientMessageId) }
            dispatch(
                LinkAction.Connection(
                    ConnectionState.CONNECTED,
                    "PUBLIC LINK · ${credentials.identityId().ifBlank { "SESSION ACTIVE" }}",
                    now,
                ),
            )
        } catch (error: Exception) {
            if (safe(error).contains("session-required", ignoreCase = true)) {
                store.clear()
                reloadSession()
            } else {
                dispatch(
                    LinkAction.Connection(
                        ConnectionState.DISCONNECTED,
                        "LINK OFFLINE · ${safe(error)}",
                        System.currentTimeMillis(),
                    ),
                )
            }
        }
    }

    private fun selectedTarget(): LinkTarget? =
        ledger.value.targets.firstOrNull { it.id == ledger.value.selectedTargetId }

    private fun dispatch(action: LinkAction) = ledger.dispatch(action)

    override fun close() {
        generation.incrementAndGet()
        polling?.cancel(true)
        recorder.cancel()
        tts.close()
        work.shutdownNow()
    }

    private fun safe(error: Throwable): String =
        error.message.orEmpty().replace(Regex("[\\r\\n]+"), " ").take(100)

    private companion object {
        const val POLL_SECONDS = 2L
        const val CATALOG_REFRESH_MS = 30_000L
        const val RECOVERED_TTS_TTL_MS = 120_000L
    }
}
