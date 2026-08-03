package io.agentmux.audioinbox.wear

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
import io.agentmux.linkui.product.generated.LinkCapturePhase
import io.agentmux.linkui.product.generated.LinkNativePortGraph
import io.agentmux.linkui.product.generated.LinkPlaybackCommand
import io.agentmux.linkui.product.generated.LinkRoute

internal class WearLinkProductPorts(
    private val controller: WearMailboxController,
) : LinkNativePortGraph {
    private var route = LinkRoute.HOME
    private val payloads = WearCapturedPayloads()

    override val navigation = LinkNavigationNativePort(
        current = { route },
        navigate = { route = it },
    )
    override val capture: CaptureServicePort = WearCaptureServicePort(controller, payloads)
    override val conversation: ConversationServicePort =
        WearConversationServicePort(controller, payloads)
    override val playback = LinkStatePlaybackServicePort(
        state = { controller.state.value },
        commandHandler = controller::handlePlayback,
    )
}

private class WearCaptureServicePort(
    private val controller: WearMailboxController,
    private val payloads: WearCapturedPayloads,
) : CaptureServicePort {
    override fun command(value: LinkCaptureCommand) {
        when (CaptureOperation.valueOf(value.operation.name)) {
            CaptureOperation.BEGIN -> {
                payloads.clear()
                controller.beginCapture()
            }
            CaptureOperation.RELEASE -> release()
            CaptureOperation.CANCEL -> {
                payloads.clear()
                controller.cancelCapture()
            }
        }
    }

    override fun status(): LinkCaptureState = LinkCaptureState(
        phase = LinkCapturePhase.valueOf(controller.state.value.capture.name),
        startedAtMs = controller.state.value.captureStartedAtMs.takeIf { it > 0L },
        byteCount = controller.recordedBytes(),
    )

    override fun captured(): LinkCapturedTurn? = payloads.snapshot()

    private fun release() {
        payloads.clear()
        val capture = controller.finishCapture() ?: return
        val target = controller.state.value.targets.firstOrNull {
            it.id == controller.state.value.selectedTargetId
        }
        if (target == null) {
            capture.file.delete()
            controller.failCapture()
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

private class WearConversationServicePort(
    private val controller: WearMailboxController,
    private val payloads: WearCapturedPayloads,
) : ConversationServicePort {
    override fun turn(value: LinkCapturedTurn) {
        val capture = payloads.take(value)
        if (!controller.deliverCapture(capture, value.targetId)) {
            capture.file.delete()
        }
    }

    override fun status() = controller.state.value.conversationState()
}

private class WearCapturedPayloads {
    private var value: Pair<WearVoiceRecorder.Capture, LinkCapturedTurn>? = null

    fun put(native: WearVoiceRecorder.Capture, contract: LinkCapturedTurn) {
        check(value == null)
        value = native to contract
    }

    fun snapshot(): LinkCapturedTurn? = value?.second

    fun take(contract: LinkCapturedTurn): WearVoiceRecorder.Capture {
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

private fun WearMailboxController.handlePlayback(command: LinkPlaybackCommand) {
    when (PlaybackOperation.valueOf(command.operation.name)) {
        PlaybackOperation.PLAY -> playTurn(command.turnId)
        PlaybackOperation.STOP -> stopPlayback()
        PlaybackOperation.PAUSE,
        PlaybackOperation.RESUME,
        -> error("Wear playback does not support ${command.operation.id}")
    }
}
