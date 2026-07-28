package io.agentmux.audioinbox

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
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
    onBegin: () -> Boolean,
    onRelease: () -> Unit,
    onCancel: () -> Unit,
) {
    var elapsed by remember { mutableLongStateOf(0) }
    var bytes by remember { mutableLongStateOf(0) }
    LaunchedEffect(phase, startedAtMs) {
        while (phase == CapturePhase.LISTENING) {
            elapsed = ((System.currentTimeMillis() - startedAtMs) / 1000).coerceAtLeast(0)
            bytes = recordedBytes()
            delay(250)
        }
        if (phase != CapturePhase.LISTENING) {
            elapsed = 0
            bytes = 0
        }
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
            centerValue = if (phase == CapturePhase.LISTENING) {
                "%d:%02d".format(elapsed / 60, elapsed % 60)
            } else {
                null
            },
            sub = VoiceUploadPolicy.warning(bytes, byteLimit)?.let {
                if (bytes > (byteLimit ?: Long.MAX_VALUE)) "OVER 5 MB" else "5 MB SOON"
            },
            onBegin = onBegin,
            onRelease = onRelease,
            onCancel = onCancel,
        ),
        diameter = 88.dp,
        modifier = Modifier,
    )
}
