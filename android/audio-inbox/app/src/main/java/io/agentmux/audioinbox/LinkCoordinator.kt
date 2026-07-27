package io.agentmux.audioinbox

import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkAction
import io.agentmux.linkcore.LinkReducer
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

internal class LinkCoordinator(
    private val activity: Activity,
) : AutoCloseable {
    data class AcceptedDraft(val turnId: String, val draft: String)

    private val preferences: SharedPreferences =
        activity.getSharedPreferences(AppContract.PREFS, Activity.MODE_PRIVATE)
    private val repository = LinkStateRepository(preferences)
    private val mutableState = MutableStateFlow(repository.load())
    private val mutableAccepted = MutableSharedFlow<AcceptedDraft>(extraBufferCapacity = 16)
    private val targets = ConcurrentHashMap<String, ConversationTarget>()
    private val discovery: ExecutorService = Executors.newFixedThreadPool(2)
    private val drafts = ConcurrentHashMap<String, String>()
    private val controller = ConversationController(
        activity,
        AppContract.consumerId(preferences),
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
            }

            override fun onReply(
                turnId: String,
                target: ConversationTarget,
                respondingTarget: String,
                text: String,
            ) {
                dispatch(LinkAction.Reply(turnId, respondingTarget, text))
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

    val state = mutableState.asStateFlow()
    val acceptedDrafts = mutableAccepted.asSharedFlow()

    init {
        preferences.registerOnSharedPreferenceChangeListener(preferenceListener)
        discoverTargets()
        syncConnection()
    }

    fun selectedTarget(): LinkTarget? =
        mutableState.value.targets.firstOrNull { it.id == mutableState.value.selectedTargetId }

    fun selectTarget(id: String) {
        dispatch(LinkAction.SelectTarget(id))
        preferences.edit().putString(AppContract.KEY_CONVERSATION_TARGET, id).apply()
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

    fun playReply(turnId: String, explicitReplay: Boolean = true) {
        val turn = mutableState.value.turns.firstOrNull { it.turnId == turnId } ?: return
        val target = targets[turn.targetId] ?: return
        if (turn.replyText.isBlank()) return
        val intent = Intent(activity, AudioInboxService::class.java).apply {
            action = if (explicitReplay) AppContract.ACTION_REPLAY_REPLY
            else AppContract.ACTION_PLAY_REPLY
            putExtra(AppContract.EXTRA_TURN_ID, turnId)
            putExtra(AppContract.EXTRA_TEXT, turn.replyText)
            putExtra(AppContract.EXTRA_SERVER, target.serverUrl)
            putExtra(AppContract.EXTRA_TARGET_LABEL, turn.respondingTarget.ifBlank { target.id })
        }
        if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent)
        else activity.startService(intent)
    }

    fun pauseAudio() = sendAudioAction(AppContract.ACTION_PAUSE_AUDIO)
    fun stopAudio() = sendAudioAction(AppContract.ACTION_STOP_AUDIO)

    fun applyUpdatePresentation(action: LinkAction.Update) {
        dispatch(action)
    }

    private fun sendAudioAction(actionName: String) {
        activity.startService(Intent(activity, AudioInboxService::class.java).apply {
            action = actionName
        })
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
            ),
        )
        discovery.execute {
            applyDiscovery(ServerDiscovery.discover(ServerDiscovery.WSL_CANDIDATES), save = true)
        }
        discovery.execute {
            applyDiscovery(ServerDiscovery.discover(ServerDiscovery.WINDOWS_CANDIDATES), save = false)
        }
    }

    private fun applyDiscovery(found: ServerDiscovery.Configuration?, save: Boolean) {
        if (found == null) {
            if (targets.isEmpty()) {
                dispatch(LinkAction.Connection(ConnectionState.DISCONNECTED, "Tailscale server not found"))
            }
            return
        }
        if (save) {
            preferences.edit()
                .putString(AppContract.KEY_SERVER, found.serverUrl)
                .putString(AppContract.KEY_TARGET, found.target)
                .apply()
        }
        found.conversationTargets.forEach { targets[it.id] = it }
        val ordered = targets.values.sortedBy { favoriteOrder(it.id) }.map {
            LinkTarget(it.id, it.label, true)
        }
        dispatch(LinkAction.Targets(ordered))
        dispatch(LinkAction.Connection(ConnectionState.CONNECTED, "Connected via Tailscale"))
        if (save && preferences.getBoolean(AppContract.KEY_ENABLED, false)) setHandsFree(true)
    }

    private fun targetForSelection(): ConversationTarget? =
        targets[mutableState.value.selectedTargetId]

    private fun dispatch(action: LinkAction) {
        val next = LinkReducer.reduce(mutableState.value, action)
        mutableState.value = next
        repository.save(next)
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
        dispatch(LinkAction.Connection(state, raw))
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
        discovery.shutdownNow()
        controller.close()
    }

    private fun favoriteOrder(id: String): Int = when (id) {
        "lsrc:3" -> 0
        "lsrc:10" -> 1
        "_windows_" -> 2
        else -> 3
    }
}
