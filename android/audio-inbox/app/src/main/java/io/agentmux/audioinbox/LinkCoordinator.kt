package io.agentmux.audioinbox

import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkMailboxSyncResult
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkStateLedger
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.RecoveredReply
import io.agentmux.linkcore.RecoveredReplyPolicy
import io.agentmux.linkcore.VoiceUploadPolicy
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

private const val RECOVERED_AUDIO_TTL_MS = 10 * 60_000L

internal class LinkCoordinator(
    private val activity: Activity,
) : AutoCloseable {
    private val preferences: SharedPreferences =
        activity.getSharedPreferences(AppContract.PREFS, Activity.MODE_PRIVATE)
    private val repository = LinkStateRepository(preferences)
    private val ledger = LinkStateLedger(repository.load(), repository::save)
    private val mutableAccepted = MutableSharedFlow<AcceptedDraft>(extraBufferCapacity = 16)
    private val targetDirectory = LinkTargetDirectory()
    private val audioActions = LinkAudioActions(activity, targetDirectory::target)
    private val linkSessions = KeystoreSessionStore(preferences)
    private val wearSessions = LinkWearSessionPublisher(activity)
    private val publicEvents = PublicMailboxFeed(linkSessions, { ledger.value }, ::applyPublicSync)
    private val discovery: ExecutorService = Executors.newFixedThreadPool(2)
    private val pendingDiscovery = AtomicInteger(2)
    private val drafts = ConcurrentHashMap<String, String>()
    private val voiceTurns = ConcurrentHashMap.newKeySet<String>()
    @Volatile private var recoveredPlaybackApplied = false
    private val linkAuth = LinkAuthController(
        activity,
        linkSessions,
        object : LinkAuthController.Listener {
            override fun onLogin(credentials: LinkSessionCredentials) {
                wearSessions.publish(credentials)
                discovery.execute(::refreshPublicTargets)
            }

            override fun onError(message: String) {
                dispatch(
                    LinkAction.Connection(
                        ledger.value.connection,
                        "Public Link login failed · $message",
                        System.currentTimeMillis(),
                    ),
                )
            }
        },
    )
    private val controller = ConversationController(
        activity,
        AppContract.consumerId(preferences),
        linkSessions,
        object : ConversationController.Listener {
            override fun onSending(
                turnId: String,
                target: ConversationTarget,
                draft: String,
            ) = Unit

            override fun onAccepted(
                turnId: String,
                target: ConversationTarget,
                visibleText: String,
            ) {
                dispatch(LinkAction.Accepted(turnId, visibleText))
                mutableAccepted.tryEmit(AcceptedDraft(turnId, drafts.remove(turnId).orEmpty()))
                if (voiceTurns.remove(turnId) &&
                    ledger.value.capture == CapturePhase.FINALIZING
                ) {
                    dispatch(LinkAction.Capture(CapturePhase.IDLE))
                }
            }

            override fun onReply(
                turnId: String,
                target: ConversationTarget,
                respondingTarget: String,
                text: String,
            ) {
                dispatch(
                    LinkAction.Reply(
                        turnId,
                        respondingTarget,
                        text,
                        System.currentTimeMillis(),
                    ),
                )
                if (preferences.getBoolean(AppContract.KEY_SPEAK_REPLIES, false)) {
                    playReply(turnId, explicitReplay = false)
                }
            }

            override fun onDeliveryFailure(
                turnId: String,
                target: ConversationTarget,
                message: String,
            ) {
                drafts.remove(turnId)
                dispatch(LinkAction.DeliveryFailed(turnId, message))
                if (voiceTurns.remove(turnId) &&
                    ledger.value.capture == CapturePhase.FINALIZING
                ) {
                    dispatch(LinkAction.Capture(CapturePhase.FAILED))
                }
            }

            override fun onReplyFailure(
                turnId: String,
                target: ConversationTarget,
                message: String,
            ) {
                dispatch(LinkAction.ReplyFailed(turnId, message))
            }
        },
    )
    private val preferenceListener =
        SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key?.startsWith("turn-playback:") == true) syncPlayback(key)
            if (key == AppContract.KEY_CONNECTION) syncConnection()
        }
    private val playbackProgressListener = PlaybackProgressBus.Listener { value ->
        activity.runOnUiThread {
            dispatch(
                LinkAction.PlaybackProgress(
                    value.turnId(),
                    value.positionMs(),
                    value.durationMs(),
                ),
            )
        }
    }

    val state = ledger.state
    val acceptedDrafts = mutableAccepted.asSharedFlow()

    init {
        preferences.registerOnSharedPreferenceChangeListener(preferenceListener)
        PlaybackProgressBus.addListener(playbackProgressListener)
        publicEvents.start()
        linkSessions.credentials()?.let(wearSessions::publish)
        discoverTargets()
        syncConnection()
    }

    fun selectedTarget(): LinkTarget? =
        ledger.value.targets.firstOrNull { it.id == ledger.value.selectedTargetId }

    fun selectTarget(id: String) {
        dispatch(LinkAction.SelectTarget(id))
        preferences.edit().putString(AppContract.KEY_CONVERSATION_TARGET, id).apply()
    }

    fun selectedVoiceByteLimit(): Long? =
        VoiceUploadPolicy.PUBLIC_MAX_BYTES.takeIf {
            targetForSelection()?.kind == ConversationTarget.Kind.PUBLIC
        }

    fun submitText(raw: String): String? {
        val text = raw.trim()
        val target = targetForSelection() ?: return null
        if (text.isEmpty()) return null
        val turnId = UUID.randomUUID().toString()
        drafts[turnId] = text
        dispatch(
            LinkAction.Submit(
                LinkTurn(
                    turnId = turnId,
                    targetId = target.id,
                    targetLabel = target.label,
                    userText = text,
                    createdAtMs = System.currentTimeMillis(),
                ),
            ),
        )
        if (!controller.sendText(target, text, turnId)) {
            dispatch(LinkAction.DeliveryFailed(turnId, "Target is unavailable"))
        }
        return turnId
    }

    fun submitAudio(capture: PushToTalkRecorder.Capture): Boolean {
        val target = targetForSelection() ?: return false
        voiceTurns.add(capture.turnId)
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
        return controller.sendAudio(target, capture.file, capture.turnId).also { accepted ->
            if (!accepted) {
                voiceTurns.remove(capture.turnId)
                dispatch(LinkAction.DeliveryFailed(capture.turnId, "Target is unavailable"))
            }
        }
    }

    fun capture(phase: CapturePhase, startedAtMs: Long = 0) {
        dispatch(LinkAction.Capture(phase, startedAtMs))
    }

    fun setHandsFree(enabled: Boolean) {
        val server = preferences.getString(AppContract.KEY_SERVER, "").orEmpty()
        val target = preferences.getString(AppContract.KEY_TARGET, "").orEmpty()
        if (enabled && (!ServerDiscovery.isAllowedServer(server) ||
                !target.matches(Regex("^\\d{10,24}$")))
        ) {
            dispatch(
                LinkAction.Connection(
                    ConnectionState.CONFIGURATION_REQUIRED,
                    "Tailscale configuration required",
                    System.currentTimeMillis(),
                ),
            )
            return
        }
        preferences.edit().putBoolean(AppContract.KEY_ENABLED, enabled).apply()
        dispatch(LinkAction.HandsFree(enabled))
        val intent = Intent(activity, AudioInboxService::class.java).apply {
            action = if (enabled) AppContract.ACTION_START else AppContract.ACTION_STOP
        }
        if (enabled && Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent)
        else activity.startService(intent)
    }

    fun setSpeakReplies(enabled: Boolean) {
        preferences.edit().putBoolean(AppContract.KEY_SPEAK_REPLIES, enabled).apply()
    }

    fun speaksReplies(): Boolean =
        preferences.getBoolean(AppContract.KEY_SPEAK_REPLIES, false)

    fun publicLoggedIn(): Boolean = linkAuth.loggedIn()

    fun beginPublicLogin() = linkAuth.beginLogin()

    fun handlePublicAuth(uri: Uri?): Boolean = linkAuth.handleDeepLink(uri)

    fun logoutPublic() {
        wearSessions.revoke()
        linkAuth.logout()
        targetDirectory.clearPublic()
        publishTargets()
        dispatch(
            LinkAction.Connection(
                if (!targetDirectory.hasTailnetRoutes()) ConnectionState.DISCONNECTED
                else ConnectionState.CONNECTED,
                if (!targetDirectory.hasTailnetRoutes()) "Public Link disconnected"
                else "Connected via Tailscale",
                System.currentTimeMillis(),
            ),
        )
    }

    fun playReply(turnId: String, explicitReplay: Boolean = true) {
        val turn = ledger.value.turns.firstOrNull { it.turnId == turnId } ?: return
        audioActions.playReply(turn, explicitReplay)
    }

    fun pauseAudio() = audioActions.pause()
    fun resumeAudio() = audioActions.resume()
    fun stopAudio() = audioActions.stop()

    fun applyUpdatePresentation(action: LinkAction.Update) {
        dispatch(action)
    }

    private fun discoverTargets() {
        val savedServer = preferences.getString(AppContract.KEY_SERVER, "").orEmpty()
        val savedTarget = preferences.getString(AppContract.KEY_TARGET, "").orEmpty()
        val saved = ServerDiscovery.isAllowedServer(savedServer) &&
            savedTarget.matches(Regex("^\\d{10,24}$"))
        dispatch(
            LinkAction.Connection(
                if (saved) ConnectionState.CONNECTING else ConnectionState.DISCONNECTED,
                if (saved) "Connecting via Tailscale" else "Finding Agentmux on Tailscale",
                System.currentTimeMillis(),
            ),
        )
        discovery.execute {
            try {
                applyDiscovery(
                    ServerDiscovery.discover(
                        ServerDiscovery.bootstrapCandidates(
                            savedServer,
                            runCatching {
                                PublicLinkClient.publishedPrivateDiscoveryUrls(
                                    PublicLinkClient.DEFAULT_BASE,
                                )
                            }.getOrDefault(emptyList()),
                        ),
                    ),
                    save = true,
                )
            } finally {
                discoveryFinished()
            }
        }
        discovery.execute {
            try {
                refreshPublicTargets()
            } finally {
                discoveryFinished()
            }
        }
    }

    private fun applyDiscovery(found: ServerDiscovery.Configuration?, save: Boolean) {
        if (found == null) {
            if (targetDirectory.isEmpty()) {
                dispatch(
                    LinkAction.Connection(
                        ConnectionState.DISCONNECTED,
                        "Tailscale server not found",
                        System.currentTimeMillis(),
                    ),
                )
            }
            return
        }
        if (save) {
            preferences.edit()
                .putString(AppContract.KEY_SERVER, found.serverUrl)
                .putString(AppContract.KEY_TARGET, found.target)
                .apply()
        }
        targetDirectory.addTailnet(found.conversationTargets)
        publishTargets()
        dispatch(
            LinkAction.Connection(
                ConnectionState.CONNECTED,
                "Connected via Tailscale",
                System.currentTimeMillis(),
            ),
        )
        if (save && preferences.getBoolean(AppContract.KEY_ENABLED, false)) setHandsFree(true)
    }

    private fun refreshPublicTargets() {
        val session = linkSessions.session()
        if (session == null) {
            targetDirectory.clearPublic()
            publishTargets()
            return
        }
        try {
            val catalog = PublicLinkClient(linkSessions.baseUrl(), session).targetCatalog()
            targetDirectory.replacePublic(catalog.targets.map {
                ConversationTarget.publicLink(it.id, it.label, it.online)
            })
            catalog.privateDiscoveryUrls.forEach { candidate ->
                ServerDiscovery.discover(listOf(candidate))?.let { found ->
                    applyDiscovery(
                        found,
                        save = found.target.matches(Regex("^\\d{10,24}$")),
                    )
                }
            }
            publishTargets()
            dispatch(
                LinkAction.Connection(
                    ConnectionState.CONNECTED,
                    LinkTargetRoutePolicy.connectionDetail(
                        hasTailnetRoute = targetDirectory.hasTailnetRoutes(),
                        hasPublicFallback = targetDirectory.hasAvailablePublicRoute(),
                    ),
                    System.currentTimeMillis(),
                ),
            )
        } catch (error: Exception) {
            if (!targetDirectory.hasTailnetRoutes()) {
                dispatch(
                    LinkAction.Connection(
                        ConnectionState.DISCONNECTED,
                        "Public Link unavailable · ${error.message.orEmpty().take(100)}",
                        System.currentTimeMillis(),
                    ),
                )
            }
        }
    }

    private fun publishTargets() {
        val chosen = targetDirectory.rebuild()
        dispatch(
            LinkAction.Targets(
                chosen.map {
                    LinkTarget(
                        id = it.id,
                        label = it.label,
                        available = it.available(),
                        acceptsMessages = it.kind == ConversationTarget.Kind.PUBLIC || it.available(),
                    )
                },
            ),
        )
    }

    private fun applyPublicSync(result: LinkMailboxSyncResult) {
        targetDirectory.updatePublicAvailability(result.heartbeatStates)
        result.actions.forEach(::dispatch)
    }

    private fun discoveryFinished() {
        if (pendingDiscovery.decrementAndGet() != 0 || recoveredPlaybackApplied) return
        recoveredPlaybackApplied = true
        activity.runOnUiThread(::recoverReplyPlayback)
    }

    private fun recoverReplyPlayback() {
        val now = System.currentTimeMillis()
        val eligible = ledger.value.turns.filter {
            it.replyPhase == io.agentmux.linkcore.ReplyPhase.READY &&
                it.playbackPhase == PlaybackPhase.IDLE &&
                it.replyText.isNotBlank()
        }
        val newest = RecoveredReplyPolicy.autoplayTurnId(
            eligible.map {
                RecoveredReply(
                    it.turnId,
                    it.replyReceivedAtMs,
                    it.replyReceivedAtMs + RECOVERED_AUDIO_TTL_MS,
                    targetDirectory.contains(it.targetId),
                )
            },
            now,
        )
        eligible.forEach { turn ->
            if (turn.turnId != newest || !speaksReplies()) {
                dispatch(LinkAction.Playback(turn.turnId, PlaybackPhase.SKIPPED))
            }
        }
        if (newest != null && speaksReplies()) playReply(newest, explicitReplay = false)
    }

    private fun targetForSelection(): ConversationTarget? =
        targetDirectory.target(ledger.value.selectedTargetId)

    private fun dispatch(action: LinkAction) {
        ledger.dispatch(action)
    }

    private fun syncConnection() {
        val raw = preferences.getString(AppContract.KEY_CONNECTION, null) ?: return
        val state = when {
            raw.startsWith("Playing", ignoreCase = true) -> ConnectionState.CONNECTED
            raw.startsWith("Connected", ignoreCase = true) -> ConnectionState.CONNECTED
            raw.startsWith("Connecting", ignoreCase = true) -> ConnectionState.CONNECTING
            raw.startsWith("Off", ignoreCase = true) -> ConnectionState.OFF
            raw.startsWith("Configuration", ignoreCase = true) ->
                ConnectionState.CONFIGURATION_REQUIRED
            else -> ConnectionState.DISCONNECTED
        }
        dispatch(LinkAction.Connection(state, raw, System.currentTimeMillis()))
    }

    private fun syncPlayback(key: String) {
        val turnId = key.substringAfter("turn-playback:")
        val phase = runCatching {
            PlaybackPhase.valueOf(preferences.getString(key, "").orEmpty().uppercase())
        }.getOrNull() ?: return
        dispatch(LinkAction.Playback(turnId, phase))
    }

    override fun close() {
        preferences.unregisterOnSharedPreferenceChangeListener(preferenceListener)
        PlaybackProgressBus.removeListener(playbackProgressListener)
        discovery.shutdownNow()
        publicEvents.close()
        linkAuth.close()
        controller.close()
    }
}
