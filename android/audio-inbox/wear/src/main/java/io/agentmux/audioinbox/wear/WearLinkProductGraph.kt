package io.agentmux.audioinbox.wear

import com.adelost.releasekit.UpdateState
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
import io.agentmux.linkui.product.LinkProductGraph
import io.agentmux.linkui.product.LinkProductSinks
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flowOf

/**
 * The wear host of the product port graph. The watch divergences stay exactly
 * where the old ports had them: no composer, no preference toggles, no
 * playback pause/resume, and no target provenance kinds. QA previews inject
 * only the state flow; the sinks stay real, as before.
 */
internal class WearLinkProductGraph private constructor(
    controller: WearMailboxController,
    navigation: LinkNavigationController,
    state: StateFlow<LinkState>,
    updateState: StateFlow<UpdateState>,
    microphoneGranted: StateFlow<Boolean>,
    capturedTurns: Flow<LinkCapturedTurn>,
    captureByteCount: () -> Long,
    captureLevel: () -> Float,
    currentVersionName: String,
    sinks: LinkProductSinks,
    private val releaseCaptureFiles: () -> Unit,
) : LinkProductGraph(
    processScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
    state = state,
    updateState = updateState,
    microphoneGranted = microphoneGranted,
    speakReplies = MutableStateFlow(false),
    // The watch replicates targets from the phone without route provenance.
    publicLinkActive = controller::hasSession,
    targetKindOf = { null },
    captureByteCount = captureByteCount,
    captureByteLimit = { null },
    captureLevel = captureLevel,
    composerDraft = flowOf(""),
    composerDraftValue = { "" },
    currentVersionName = currentVersionName,
    devPreviewPort = null,
    capturedTurns = capturedTurns,
    navigation = navigation,
    sinks = sinks,
) {
    override fun close() {
        releaseCaptureFiles()
        super.close()
    }

    companion object {
        fun create(
            controller: WearMailboxController,
            updater: LinkUpdater,
            navigation: LinkNavigationController,
            microphoneGranted: StateFlow<Boolean>,
            state: StateFlow<LinkState> = controller.state,
            currentVersionName: String,
            requestMicrophone: () -> Unit,
            openAttachment: (String) -> Unit,
        ): WearLinkProductGraph {
            val captures = WearCaptureAdapter(controller)
            return WearLinkProductGraph(
                controller = controller,
                navigation = navigation,
                state = state,
                updateState = updater.state,
                microphoneGranted = microphoneGranted,
                capturedTurns = captures.captured,
                captureByteCount = controller::recordedBytes,
                captureLevel = controller::recordedLevel,
                currentVersionName = currentVersionName,
                sinks = LinkProductSinks(
                    captureCommand = { event ->
                        if (event.operation == CaptureOperation.RECOVER) requestMicrophone()
                        else captures.command(event)
                    },
                    capturedTurn = captures::deliver,
                    compose = { error("Wear has no composer surface") },
                    editComposer = { error("Wear has no composer surface") },
                    playbackCommand = { event ->
                        when (event.operation) {
                            PlaybackOperation.PLAY -> controller.playTurn(event.turnId)
                            PlaybackOperation.STOP -> controller.stopPlayback()
                            PlaybackOperation.PAUSE,
                            PlaybackOperation.RESUME,
                            -> error(
                                "Wear playback does not support ${event.operation.name.lowercase()}",
                            )
                        }
                    },
                    targetSelect = { event -> controller.selectTarget(event.targetId) },
                    preferenceToggle = { event ->
                        when (event.key) {
                            LinkPreferenceKey.HANDS_FREE ->
                                error("Wear has no hands-free preference surface")
                            LinkPreferenceKey.SPEAK_REPLIES ->
                                error("Wear has no speak-replies preference surface")
                        }
                    },
                    updateCommand = { event ->
                        when (event.operation) {
                            LinkUpdateOperation.CHECK -> updater.start()
                            LinkUpdateOperation.RETRY -> updater.retry()
                            LinkUpdateOperation.INSTALL -> updater.install()
                        }
                    },
                    publicLinkCommand = { error("Wear has no public-link component") },
                    openAttachment = { event -> openAttachment(event.url) },
                ),
                releaseCaptureFiles = captures::clear,
            )
        }
    }
}

/** The wear half of the capture adapter contract; see the phone adapter. */
private class WearCaptureAdapter(
    private val controller: WearMailboxController,
) {
    private var pending: Pair<WearVoiceRecorder.Capture, LinkCapturedTurn>? = null
    val captured = MutableSharedFlow<LinkCapturedTurn>(extraBufferCapacity = 1)

    fun command(event: LinkCaptureCommandEvent) {
        when (event.operation) {
            CaptureOperation.BEGIN -> {
                clear()
                controller.beginCapture()
            }
            CaptureOperation.RELEASE -> release()
            CaptureOperation.CANCEL -> {
                clear()
                controller.cancelCapture()
            }
            CaptureOperation.RECOVER -> error("Capture permission recovery belongs to the host sink")
        }
    }

    fun deliver(turn: LinkCapturedTurn) {
        val current = checkNotNull(pending) { "No native capture for ${turn.turnId}" }
        check(current.second == turn) { "Captured turn contract does not match native payload" }
        pending = null
        if (!controller.deliverCapture(current.first, turn.targetId)) {
            current.first.file.delete()
        }
    }

    fun clear() {
        pending?.first?.file?.delete()
        pending = null
    }

    private fun release() {
        clear()
        val capture = controller.finishCapture() ?: return
        val target = controller.state.value.targets.firstOrNull {
            it.id == controller.state.value.selectedTargetId
        }
        if (target == null) {
            capture.file.delete()
            controller.failCapture()
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
