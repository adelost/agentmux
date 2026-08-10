package io.agentmux.linkui

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.ui.IconRing
import com.adelost.ringkit.ui.RingAudioCaptureFeedback
import com.adelost.ringkit.ui.RingAudioCaptureFeedbackSpec
import com.adelost.ringkit.ui.RingPressLifecycle
import com.adelost.ringkit.ui.RingPressLifecycleSpec
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.VoiceUploadPolicy
import io.agentmux.linkcore.CaptureOperation
import io.agentmux.linkui.product.LinkCaptureCommandEvent
import io.agentmux.linkui.product.generated.GeneratedTalkRenderEmitter
import io.agentmux.linkui.product.generated.GeneratedTalkRenderInputs

/** Why the same recorder control is ready, recoverable, or unavailable. */
sealed interface LinkCaptureAvailability {
    data object Ready : LinkCaptureAvailability
    data class Recoverable(val label: String, val detail: String) : LinkCaptureAvailability
    data class Blocked(val label: String, val detail: String) : LinkCaptureAvailability
}

fun resolveLinkCaptureAvailability(
    hasTarget: Boolean,
    targetAcceptsMessages: Boolean,
    microphoneGranted: Boolean,
    finalizing: Boolean,
): LinkCaptureAvailability = when {
    finalizing -> LinkCaptureAvailability.Blocked("SENDING", "PLEASE WAIT")
    !microphoneGranted -> LinkCaptureAvailability.Recoverable(
        "ENABLE MIC",
        "MICROPHONE PERMISSION",
    )
    !hasTarget -> LinkCaptureAvailability.Blocked("NO TARGET", "SELECT AGENT")
    !targetAcceptsMessages -> LinkCaptureAvailability.Blocked("UNAVAILABLE", "NO DELIVERY ROUTE")
    else -> LinkCaptureAvailability.Ready
}

/** Host-neutral data for the one Phone/Wear capture component. */
data class LinkCaptureSpec(
    val phase: CapturePhase,
    val startedAtMs: Long,
    val availability: LinkCaptureAvailability,
    val byteLimit: Long? = null,
)

/**
 * The only Link PTT renderer. CircleKit owns both the 200 ms arming progress
 * and the active waveform; Phone and Wear provide state and recorder ports.
 */
@Composable
fun LinkCaptureControl(
    inputs: GeneratedTalkRenderInputs,
    emitter: GeneratedTalkRenderEmitter,
) {
    val model = inputs.model
    val spec = LinkCaptureSpec(
        phase = model.phase,
        startedAtMs = model.startedAtMs ?: 0L,
        availability = when {
            model.available -> LinkCaptureAvailability.Ready
            model.recoveryActionAvailable -> LinkCaptureAvailability.Recoverable(
                "ENABLE MIC", model.unavailableReason.orEmpty(),
            )
            else -> LinkCaptureAvailability.Blocked("UNAVAILABLE", model.unavailableReason.orEmpty())
        },
        byteLimit = model.byteLimit,
    )
    var elapsedMs by remember { mutableLongStateOf(0L) }
    var bytes by remember { mutableLongStateOf(0L) }
    val levels = remember { mutableStateListOf<Float>() }
    LaunchedEffect(model.sampledAtMs) {
        if (spec.phase == CapturePhase.LISTENING) {
            elapsedMs = (model.sampledAtMs - spec.startedAtMs).coerceAtLeast(0L)
            bytes = model.byteCount
            if (levels.size == AUDIO_LEVEL_COUNT) levels.removeAt(0)
            levels += model.level.coerceIn(0f, 1f)
        } else {
            elapsedMs = 0L
            bytes = 0L
            levels.clear()
        }
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        if (spec.phase == CapturePhase.LISTENING) {
            RingAudioCaptureFeedback(
                RingAudioCaptureFeedbackSpec(
                    elapsedMs = elapsedMs,
                    levels = levels.toList(),
                    active = true,
                ),
            )
        }
        when (val availability = spec.availability) {
            is LinkCaptureAvailability.Recoverable -> {
                IconRing(
                    icon = RingIcons.Record,
                    label = availability.label,
                    sub = availability.detail,
                    onTap = { emitter.command(LinkCaptureCommandEvent(CaptureOperation.RECOVER)) },
                    diameter = 72.dp,
                )
            }
            else -> RingPressLifecycle(
                spec = RingPressLifecycleSpec(
                    label = when (spec.phase) {
                        CapturePhase.LISTENING -> "LISTENING"
                        CapturePhase.FINALIZING -> "SENDING"
                        CapturePhase.FAILED -> "TRY AGAIN"
                        CapturePhase.IDLE -> when (availability) {
                            LinkCaptureAvailability.Ready -> "HOLD TO TALK"
                            is LinkCaptureAvailability.Blocked -> availability.label
                            is LinkCaptureAvailability.Recoverable -> error("handled above")
                        }
                    },
                    active = spec.phase == CapturePhase.LISTENING,
                    enabled = availability == LinkCaptureAvailability.Ready,
                    sub = when (availability) {
                        LinkCaptureAvailability.Ready -> VoiceUploadPolicy.warning(bytes, spec.byteLimit)
                            ?.let { if (bytes > (spec.byteLimit ?: Long.MAX_VALUE)) "OVER 5 MB" else "5 MB SOON" }
                        is LinkCaptureAvailability.Blocked -> availability.detail
                        is LinkCaptureAvailability.Recoverable -> availability.detail
                    },
                    onBegin = {
                        emitter.command(LinkCaptureCommandEvent(CaptureOperation.BEGIN))
                        true
                    },
                    onRelease = { emitter.command(LinkCaptureCommandEvent(CaptureOperation.RELEASE)) },
                    onCancel = { emitter.command(LinkCaptureCommandEvent(CaptureOperation.CANCEL)) },
                ),
                diameter = 72.dp,
            )
        }
    }
}

private const val AUDIO_LEVEL_COUNT = 24
