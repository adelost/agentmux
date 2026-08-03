package io.agentmux.audioinbox

import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.CaptureOperation
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkui.product.LinkNavigationNativePort
import io.agentmux.linkui.product.LinkStatePlaybackServicePort
import io.agentmux.linkui.product.conversationState
import io.agentmux.linkui.product.generated.CaptureServicePort
import io.agentmux.linkui.product.generated.ConversationServicePort
import io.agentmux.linkui.product.generated.LinkCaptureCommand
import io.agentmux.linkui.product.generated.LinkCapturedTurn
import io.agentmux.linkui.product.generated.LinkCaptureState
import io.agentmux.linkui.product.generated.LinkNativePortGraph
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkCapturePhase
import io.agentmux.linkui.product.generated.LinkRoute

internal class PhoneLinkProductPorts(
    coordinator: LinkCoordinator,
    recorder: PushToTalkRecorder,
    currentRoute: () -> LinkRoute,
    navigate: (LinkRoute) -> Unit,
) : LinkNativePortGraph {
    private val payloads = PhoneCapturedPayloads()

    override val navigation = LinkNavigationNativePort(currentRoute, navigate)
    override val capture: CaptureServicePort = PhoneCaptureServicePort(
        coordinator,
        recorder,
        payloads,
    )
    override val conversation: ConversationServicePort =
        PhoneConversationServicePort(coordinator, payloads)
    override val playback = LinkStatePlaybackServicePort(
        state = { coordinator.state.value },
        commandHandler = { command -> coordinator.handlePlayback(command) },
    )
}

private class PhoneCaptureServicePort(
    private val coordinator: LinkCoordinator,
    private val recorder: PushToTalkRecorder,
    private val payloads: PhoneCapturedPayloads,
) : CaptureServicePort {
    override fun command(value: LinkCaptureCommand) {
        when (CaptureOperation.valueOf(value.operation.name)) {
            CaptureOperation.BEGIN -> begin()
            CaptureOperation.RELEASE -> release()
            CaptureOperation.CANCEL -> {
                payloads.clear()
                recorder.cancel()
                coordinator.capture(CapturePhase.FAILED)
            }
        }
    }

    override fun status(): LinkCaptureState = LinkCaptureState(
        phase = LinkCapturePhase.valueOf(coordinator.state.value.capture.name),
        startedAtMs = coordinator.state.value.captureStartedAtMs.takeIf { it > 0L },
        byteCount = recorder.currentBytes(),
    )

    override fun captured(): LinkCapturedTurn? = payloads.snapshot()

    private fun begin() {
        payloads.clear()
        val capture = recorder.begin()
        if (capture == null) {
            coordinator.capture(CapturePhase.FAILED)
        } else {
            coordinator.capture(CapturePhase.LISTENING, capture.startedAtMs)
        }
    }

    private fun release() {
        payloads.clear()
        coordinator.capture(CapturePhase.FINALIZING)
        val capture = recorder.release()
        val target = coordinator.selectedTarget()
        if (capture == null || target == null) {
            capture?.file?.delete()
            coordinator.capture(CapturePhase.FAILED)
            return
        }
        payloads.put(
            capture,
            LinkCapturedTurn(
                turnId = capture.turnId,
                targetId = target.id,
                payloadRef = capture.file.absolutePath,
                idempotencyKey = capture.turnId,
                createdAtMs = capture.startedAtMs,
            ),
        )
    }
}

private class PhoneConversationServicePort(
    private val coordinator: LinkCoordinator,
    private val payloads: PhoneCapturedPayloads,
) : ConversationServicePort {
    override fun turn(value: LinkCapturedTurn) {
        val capture = payloads.take(value)
        if (!coordinator.submitAudio(capture)) {
            capture.file.delete()
            coordinator.capture(CapturePhase.FAILED)
        }
    }

    override fun status() = coordinator.state.value.conversationState()
}

private class PhoneCapturedPayloads {
    private var value: Pair<PushToTalkRecorder.Capture, LinkCapturedTurn>? = null

    fun put(native: PushToTalkRecorder.Capture, contract: LinkCapturedTurn) {
        check(value == null)
        value = native to contract
    }

    fun snapshot(): LinkCapturedTurn? = value?.second

    fun take(contract: LinkCapturedTurn): PushToTalkRecorder.Capture {
        val current = checkNotNull(value) { "No native capture for ${contract.turnId}" }
        check(current.second == contract) { "Captured turn contract does not match native payload" }
        value = null
        return current.first
    }

    fun clear() {
        value?.first?.file?.delete()
        value = null
    }
}

private fun LinkCoordinator.handlePlayback(command: LinkPlaybackCommand) {
    when (PlaybackOperation.valueOf(command.operation.name)) {
        PlaybackOperation.PLAY -> playReply(command.turnId)
        PlaybackOperation.PAUSE -> pauseAudio()
        PlaybackOperation.RESUME -> resumeAudio()
        PlaybackOperation.STOP -> stopAudio()
    }
}
