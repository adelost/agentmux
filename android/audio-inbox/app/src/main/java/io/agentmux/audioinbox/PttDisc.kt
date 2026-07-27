package io.agentmux.audioinbox

import android.view.HapticFeedbackConstants
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
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
    val view = LocalView.current
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
    CircularControl(
        diameter = 112.dp,
        active = phase == CapturePhase.LISTENING,
        modifier = Modifier
            .semantics {
                contentDescription =
                    "Hold to talk. Release to send. Recording has no hidden time limit."
            }
            .pointerInput(enabled) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    down.consume()
                    if (!enabled || !onBegin()) return@awaitEachGesture
                    view.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                    var cancelled = false
                    while (true) {
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        event.changes.forEach { it.consume() }
                        if (event.changes.any { it.isConsumed && !it.pressed }) {
                            onRelease()
                            break
                        }
                        if (event.changes.isEmpty()) {
                            cancelled = true
                            break
                        }
                    }
                    if (cancelled) onCancel()
                }
            },
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                text = when (phase) {
                    CapturePhase.LISTENING -> "LISTENING"
                    CapturePhase.FINALIZING -> "SENDING"
                    CapturePhase.FAILED -> "TRY AGAIN"
                    CapturePhase.IDLE -> "HOLD TO TALK"
                },
                color = if (phase == CapturePhase.LISTENING) LinkTokens.AccentInk
                else LinkTokens.Ink,
                fontWeight = FontWeight.Bold,
            )
            if (phase == CapturePhase.LISTENING) {
                Text(
                    text = "%d:%02d".format(elapsed / 60, elapsed % 60),
                    color = LinkTokens.AccentInk,
                )
                if (VoiceUploadPolicy.warning(bytes, byteLimit) != null) {
                    Text(
                        text = if (bytes > (byteLimit ?: Long.MAX_VALUE)) {
                            "OVER 5 MB"
                        } else {
                            "5 MB SOON"
                        },
                        color = Color(0xFF502B00),
                    )
                }
            }
        }
    }
}
