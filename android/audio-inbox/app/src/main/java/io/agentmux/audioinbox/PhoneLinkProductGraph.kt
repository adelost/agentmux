package io.agentmux.audioinbox

import io.agentmux.audioinbox.update.LinkUpdater
import io.agentmux.linkcore.CaptureOperation
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.LinkPreferenceKey
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkUpdateOperation
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkui.product.LinkCapturedTurn
import io.agentmux.linkui.product.LinkCaptureCommandEvent
import io.agentmux.linkui.product.LinkNavigationController
import io.agentmux.linkui.product.LinkPlaybackCommandEvent
import io.agentmux.linkui.product.LinkPreferenceToggleEvent
import io.agentmux.linkui.product.LinkProductGraph
import io.agentmux.linkui.product.LinkProductSinks
import io.agentmux.linkui.product.LinkUpdateCommandEvent
import com.adelost.releasekit.UpdateState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The phone host of the product port graph. `real` wires the coordinator,
 * recorder and updater; `qa` injects the preview state and the local capture
 * fakes the qa_state/qa_page extras have always driven.
 */
internal class PhoneLinkProductGraph private constructor(
    private val coordinator: LinkCoordinator,
    navigation: LinkNavigationController,
    state: StateFlow<LinkState>,
    updateState: StateFlow<UpdateState>,
    microphoneGranted: StateFlow<Boolean>,
    speakReplies: StateFlow<Boolean>,
    capturedTurns: Flow<LinkCapturedTurn>,
    captureByteCount: () -> Long,
    sinks: LinkProductSinks,
    private val composer: ComposerDraftStore,
    private val releaseCaptureFiles: () -> Unit,
) : LinkProductGraph(
    processScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    state = state,
    updateState = updateState,
    microphoneGranted = microphoneGranted,
    speakReplies = speakReplies,
    publicLinkActive = coordinator::publicLoggedIn,
    targetKindOf = coordinator::targetKind,
    captureByteCount = captureByteCount,
    captureByteLimit = coordinator::selectedVoiceByteLimit,
    capturedTurns = capturedTurns,
    navigation = navigation,
    sinks = sinks,
) {
    val composerDraft: StateFlow<ComposerDraft> get() = composer.draft

    fun onComposerEdited(text: String) = composer.edit(text)

    init {
        processScope.launch {
            coordinator.acceptedDrafts.collect { accepted ->
                composer.accepted(accepted.turnId, accepted.draft)
            }
        }
    }

    override fun close() {
        releaseCaptureFiles()
        super.close()
    }

    companion object {
        fun real(
            coordinator: LinkCoordinator,
            recorder: PushToTalkRecorder,
            updater: LinkUpdater,
            navigation: LinkNavigationController,
            microphoneGranted: StateFlow<Boolean>,
        ): PhoneLinkProductGraph {
            val captures = PhoneCaptureAdapter(coordinator, recorder)
            val composer = ComposerDraftStore()
            val speakReplies = MutableStateFlow(coordinator.speaksReplies())
            return PhoneLinkProductGraph(
                coordinator = coordinator,
                navigation = navigation,
                state = coordinator.state,
                updateState = updater.state,
                microphoneGranted = microphoneGranted,
                speakReplies = speakReplies,
                capturedTurns = captures.captured,
                captureByteCount = recorder::currentBytes,
                sinks = LinkProductSinks(
                    captureCommand = captures::command,
                    capturedTurn = captures::deliver,
                    compose = { event ->
                        coordinator.submitText(event.text)?.let(composer::submitted)
                    },
                    playbackCommand = coordinatorPlayback(coordinator),
                    targetSelect = { event -> coordinator.selectTarget(event.targetId) },
                    preferenceToggle = phonePreferenceToggle(coordinator, speakReplies),
                    updateCommand = updaterCommands(updater),
                ),
                composer = composer,
                releaseCaptureFiles = captures::clear,
            )
        }

        fun qa(
            qaState: MutableStateFlow<LinkState>,
            updateState: StateFlow<UpdateState>,
            coordinator: LinkCoordinator,
            updater: LinkUpdater,
            navigation: LinkNavigationController,
        ): PhoneLinkProductGraph {
            val composer = ComposerDraftStore()
            val speakReplies = MutableStateFlow(coordinator.speaksReplies())
            return PhoneLinkProductGraph(
                coordinator = coordinator,
                navigation = navigation,
                state = qaState,
                updateState = updateState,
                microphoneGranted = MutableStateFlow(true),
                speakReplies = speakReplies,
                // A mounted recorder is an idle event source, not a completed
                // stream. Completion unmounts the real generated output port.
                capturedTurns = MutableSharedFlow(),
                captureByteCount = { 0L },
                sinks = LinkProductSinks(
                    captureCommand = { event ->
                        when (event.operation) {
                            CaptureOperation.BEGIN -> qaState.update {
                                it.copy(
                                    capture = CapturePhase.LISTENING,
                                    captureStartedAtMs = System.currentTimeMillis(),
                                )
                            }
                            CaptureOperation.RELEASE -> qaState.update {
                                it.copy(capture = CapturePhase.IDLE)
                            }
                            CaptureOperation.CANCEL -> qaState.update {
                                it.copy(capture = CapturePhase.FAILED)
                            }
                        }
                    },
                    capturedTurn = { },
                    compose = { composer.clear() },
                    playbackCommand = coordinatorPlayback(coordinator),
                    targetSelect = { event ->
                        qaState.update { it.copy(selectedTargetId = event.targetId) }
                    },
                    preferenceToggle = phonePreferenceToggle(coordinator, speakReplies),
                    updateCommand = updaterCommands(updater),
                ),
                composer = composer,
                releaseCaptureFiles = { },
            )
        }

        private fun coordinatorPlayback(
            coordinator: LinkCoordinator,
        ): (LinkPlaybackCommandEvent) -> Unit = { event ->
            when (event.operation) {
                PlaybackOperation.PLAY -> coordinator.playReply(event.turnId)
                PlaybackOperation.PAUSE -> coordinator.pauseAudio()
                PlaybackOperation.RESUME -> coordinator.resumeAudio()
                PlaybackOperation.STOP -> coordinator.stopAudio()
            }
        }

        private fun phonePreferenceToggle(
            coordinator: LinkCoordinator,
            speakReplies: MutableStateFlow<Boolean>,
        ): (LinkPreferenceToggleEvent) -> Unit = { event ->
            when (event.key) {
                LinkPreferenceKey.HANDS_FREE -> coordinator.setHandsFree(event.enabled)
                LinkPreferenceKey.SPEAK_REPLIES -> {
                    coordinator.setSpeakReplies(event.enabled)
                    speakReplies.value = event.enabled
                }
            }
        }

        private fun updaterCommands(updater: LinkUpdater): (LinkUpdateCommandEvent) -> Unit =
            { event ->
                when (event.operation) {
                    LinkUpdateOperation.CHECK -> updater.start()
                    LinkUpdateOperation.RETRY -> updater.retry()
                    LinkUpdateOperation.INSTALL -> updater.install()
                }
            }
    }
}

/** The submitted-text draft reconciliation the composer row has always had. */
private class ComposerDraftStore {
    private val mutableDraft = MutableStateFlow(ComposerDraft())
    val draft: StateFlow<ComposerDraft> = mutableDraft.asStateFlow()

    fun edit(text: String) = mutableDraft.update { it.edited(text) }

    fun submitted(turnId: String) = mutableDraft.update { it.submitted(turnId) }

    fun accepted(turnId: String, draft: String) = mutableDraft.update { it.accepted(turnId, draft) }

    fun clear() {
        mutableDraft.value = ComposerDraft()
    }
}

/**
 * Owns the native audio payload behind capture.service.captured. The graph
 * carries the typed [LinkCapturedTurn]; the file stays here and is handed to
 * the conversation sink when the generated edge delivers the turn.
 */
private class PhoneCaptureAdapter(
    private val coordinator: LinkCoordinator,
    private val recorder: PushToTalkRecorder,
) {
    private var pending: Pair<PushToTalkRecorder.Capture, LinkCapturedTurn>? = null
    val captured = MutableSharedFlow<LinkCapturedTurn>(extraBufferCapacity = 1)

    fun command(event: LinkCaptureCommandEvent) {
        when (event.operation) {
            CaptureOperation.BEGIN -> begin()
            CaptureOperation.RELEASE -> release()
            CaptureOperation.CANCEL -> {
                clear()
                recorder.cancel()
                coordinator.capture(CapturePhase.FAILED)
            }
        }
    }

    fun deliver(turn: LinkCapturedTurn) {
        val current = checkNotNull(pending) { "No native capture for ${turn.turnId}" }
        check(current.second == turn) { "Captured turn contract does not match native payload" }
        pending = null
        if (!coordinator.submitAudio(current.first)) {
            current.first.file.delete()
            coordinator.capture(CapturePhase.FAILED)
        }
    }

    fun clear() {
        pending?.first?.file?.delete()
        pending = null
    }

    private fun begin() {
        clear()
        val capture = recorder.begin()
        if (capture == null) {
            coordinator.capture(CapturePhase.FAILED)
        } else {
            coordinator.capture(CapturePhase.LISTENING, capture.startedAtMs)
        }
    }

    private fun release() {
        clear()
        coordinator.capture(CapturePhase.FINALIZING)
        val capture = recorder.release()
        val target = coordinator.selectedTarget()
        if (capture == null || target == null) {
            capture?.file?.delete()
            coordinator.capture(CapturePhase.FAILED)
            return
        }
        val turn = LinkCapturedTurn(
            turnId = capture.turnId,
            targetId = target.id,
            payloadRef = capture.file.absolutePath,
            idempotencyKey = capture.turnId,
            createdAtMs = capture.startedAtMs,
        )
        pending = capture to turn
        captured.tryEmit(turn)
    }
}
