package io.agentmux.linkui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.dp
import com.adelost.designkit.ui.RingIcons
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.designkit.ui.CircleSurfaceClass
import com.adelost.ringkit.ui.IconRing
import com.adelost.ringkit.ui.RingAudioCaptureFeedback
import com.adelost.ringkit.ui.RingAudioCaptureFeedbackSpec
import com.adelost.ringkit.ui.RingPressLifecycle
import com.adelost.ringkit.ui.RingPressLifecycleSpec
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.VoiceUploadPolicy
import io.agentmux.wakeword.WakePhase
import io.agentmux.wakeword.WakeStatus
import kotlinx.coroutines.delay

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
    /** The hands-free loop; OFF on hosts without a wake word. */
    val wake: WakeStatus = WakeStatus(),
)

/**
 * The only Link recording renderer. Begin immediately, with no arming sweep.
 * The shared graph discards accidental short presses; CircleKit owns the waveform.
 */
@Composable
fun LinkCaptureControl(
    spec: LinkCaptureSpec,
    recordedBytes: () -> Long,
    recordedLevel: () -> Float,
    onBegin: () -> Boolean,
    onRelease: () -> Unit,
    onCancel: () -> Unit,
    onRecover: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val diameter = if (LocalCircleSurfaceLayout.current.surfaceClass == CircleSurfaceClass.ROUND) 72.dp else 56.dp
    var elapsedMs by remember { mutableLongStateOf(0L) }
    var bytes by remember { mutableLongStateOf(0L) }
    val levels = remember { mutableStateListOf<Float>() }
    val handsFree = linkHandsFreeTalk(spec.wake)
        ?.takeIf { spec.phase == CapturePhase.IDLE && spec.availability == LinkCaptureAvailability.Ready }
    val handsFreeRecording = handsFree?.recording == true
    val latestWake by rememberUpdatedState(spec.wake)
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(spec.phase, spec.startedAtMs, handsFreeRecording) {
        if (handsFreeRecording) haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        val startedAtMs = if (handsFreeRecording) System.currentTimeMillis() else spec.startedAtMs
        while (spec.phase == CapturePhase.LISTENING || handsFreeRecording) {
            elapsedMs = (System.currentTimeMillis() - startedAtMs).coerceAtLeast(0L)
            if (!handsFreeRecording) bytes = recordedBytes()
            if (levels.size == AUDIO_LEVEL_COUNT) levels.removeAt(0)
            levels += (if (handsFreeRecording) latestWake.hearing?.level ?: 0f else recordedLevel()).coerceIn(0f, 1f)
            delay(AUDIO_LEVEL_SAMPLE_MS)
        }
        elapsedMs = 0L
        bytes = 0L
        levels.clear()
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = modifier) {
        val recording = spec.phase == CapturePhase.LISTENING || handsFreeRecording
        // Keep the atom's measured space, including font metrics. Inserting it
        // at BEGIN moves the held control away from the original finger.
        RingAudioCaptureFeedback(
            RingAudioCaptureFeedbackSpec(elapsedMs, levels.toList(), active = recording),
            modifier = Modifier.widthIn(max = diameter * 2f).then(
                if (recording) Modifier else Modifier.alpha(0f).clearAndSetSemantics { }),
        )
        when (val availability = spec.availability) {
            is LinkCaptureAvailability.Recoverable -> {
                val recover = requireNotNull(onRecover) {
                    "Recoverable capture availability requires a recovery action"
                }
                IconRing(
                    icon = RingIcons.Record,
                    label = availability.label,
                    sub = availability.detail,
                    onTap = recover,
                    diameter = diameter,
                )
            }
            else -> RingPressLifecycle(
                spec = RingPressLifecycleSpec(
                    holdMs = 0L,
                    label = handsFree?.label ?: when (spec.phase) {
                        CapturePhase.LISTENING -> "RELEASE TO SEND"
                        CapturePhase.FINALIZING -> "SENDING"
                        CapturePhase.FAILED -> "TRY AGAIN"
                        CapturePhase.IDLE -> when (availability) {
                            LinkCaptureAvailability.Ready -> "HOLD TO TALK"
                            is LinkCaptureAvailability.Blocked -> availability.label
                            is LinkCaptureAvailability.Recoverable -> error("handled above")
                        }
                    },
                    active = recording,
                    enabled = availability == LinkCaptureAvailability.Ready,
                    centerValue = handsFree?.centerValue,
                    sub = handsFree?.sub ?: when (availability) {
                        LinkCaptureAvailability.Ready -> VoiceUploadPolicy.warning(bytes, spec.byteLimit)
                            ?.let { if (bytes > (spec.byteLimit ?: Long.MAX_VALUE)) "OVER 5 MB" else "5 MB SOON" }
                            ?: if (recording) "SLIDE AWAY TO CANCEL" else ""
                        is LinkCaptureAvailability.Blocked -> availability.detail
                        is LinkCaptureAvailability.Recoverable -> availability.detail
                    },
                    // While hands-free hears or sends a question, holding would fight it for the microphone.
                    onBegin = { spec.wake.phase !in HANDS_FREE_OWNS_MICROPHONE && onBegin() },
                    onRelease = onRelease,
                    onCancel = onCancel,
                ),
                diameter = diameter,
            )
        }
    }
}

private val HANDS_FREE_OWNS_MICROPHONE = setOf(WakePhase.CAPTURING, WakePhase.FOLLOW_UP, WakePhase.SENDING)
private const val AUDIO_LEVEL_COUNT = 24
private const val AUDIO_LEVEL_SAMPLE_MS = 100L
