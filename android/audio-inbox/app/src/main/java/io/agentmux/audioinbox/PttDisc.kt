package io.agentmux.audioinbox

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
import com.adelost.ringkit.ui.RingAudioCaptureFeedback
import com.adelost.ringkit.ui.RingAudioCaptureFeedbackSpec
import com.adelost.ringkit.ui.RingPressLifecycle
import com.adelost.ringkit.ui.RingPressLifecycleSpec
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.VoiceUploadPolicy
import kotlinx.coroutines.delay

@Composable
internal fun PttDisc(
    phase: CapturePhase,
    startedAtMs: Long,
    enabled: Boolean,
    byteLimit: Long?,
    recordedBytes: () -> Long,
    recordedLevel: () -> Float,
    onBegin: () -> Boolean,
    onRelease: () -> Unit,
    onCancel: () -> Unit,
) {
    var elapsedMs by remember { mutableLongStateOf(0) }
    var bytes by remember { mutableLongStateOf(0) }
    val levels = remember { mutableStateListOf<Float>() }
    LaunchedEffect(phase, startedAtMs) {
        while (phase == CapturePhase.LISTENING) {
            elapsedMs = (System.currentTimeMillis() - startedAtMs).coerceAtLeast(0)
            bytes = recordedBytes()
            if (levels.size == 24) levels.removeAt(0)
            levels += recordedLevel().coerceIn(0f, 1f)
            delay(100)
        }
        if (phase != CapturePhase.LISTENING) {
            elapsedMs = 0
            bytes = 0
            levels.clear()
        }
    }
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        if (phase == CapturePhase.LISTENING) {
            RingAudioCaptureFeedback(
                RingAudioCaptureFeedbackSpec(
                    elapsedMs = elapsedMs,
                    levels = levels.toList(),
                    active = true,
                ),
            )
        }
        RingPressLifecycle(
            spec = RingPressLifecycleSpec(
                label = when (phase) {
                    CapturePhase.LISTENING -> "LISTENING"
                    CapturePhase.FINALIZING -> "SENDING"
                    CapturePhase.FAILED -> "TRY AGAIN"
                    CapturePhase.IDLE -> "HOLD TO TALK"
                },
                active = phase == CapturePhase.LISTENING,
                enabled = enabled,
                sub = VoiceUploadPolicy.warning(bytes, byteLimit)?.let {
                    if (bytes > (byteLimit ?: Long.MAX_VALUE)) "OVER 5 MB" else "5 MB SOON"
                },
                onBegin = onBegin,
                onRelease = onRelease,
                onCancel = onCancel,
            ),
            diameter = 72.dp,
            modifier = Modifier,
        )
    }
}
