package io.agentmux.audioinbox.wear

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.verticalScroll
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkState
import com.adelost.designkit.ui.GraphiteTokens
import io.agentmux.linkcore.PlaybackPhase

private val Canvas = GraphiteTokens.Canvas
private val SurfaceInk = GraphiteTokens.SurfaceStrong
private val Ink = GraphiteTokens.Ink
private val Muted = GraphiteTokens.Muted
private val Accent = GraphiteTokens.Primary

@Composable
internal fun WearLinkScreen(
    state: LinkState,
    onSelectTarget: (String) -> Unit,
    onHoldToTalk: () -> Unit,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
) {
    val latest = state.turns.lastOrNull()
    val selected = state.targets.firstOrNull { it.id == state.selectedTargetId }
        ?: state.targets.firstOrNull()
    val next = state.targets.let { targets ->
        val index = targets.indexOf(selected)
        targets.getOrNull((index + 1).mod(targets.size.coerceAtLeast(1)))
    }
    MaterialTheme(
        colorScheme = darkColorScheme(
            background = Canvas,
            surface = SurfaceInk,
            onSurface = Ink,
            primary = Accent,
        ),
    ) {
        Box(
            contentAlignment = Alignment.TopCenter,
            modifier = Modifier.fillMaxSize().background(Canvas),
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(5.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(top = 24.dp, bottom = 24.dp, start = 18.dp, end = 18.dp),
            ) {
                Text("AGENTMUX LINK", color = Accent, fontSize = 10.sp)
                Text(
                    text = connectionLabel(state.connection),
                    color = if (state.connection == ConnectionState.CONNECTED) Accent else Muted,
                    fontSize = 11.sp,
                )
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .width(110.dp)
                        .height(34.dp)
                        .background(SurfaceInk, RoundedCornerShape(17.dp))
                        .clickable(enabled = state.targets.any { it.available }) {
                            next?.let { onSelectTarget(it.id) }
                        },
                ) {
                    Text("${selected?.id ?: "No target"} ▾", fontSize = 10.sp)
                }
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(56.dp)
                        .background(SurfaceInk, CircleShape)
                        .border(BorderStroke(1.dp, Accent.copy(alpha = 0.55f)), CircleShape)
                        .clickable(
                            enabled = state.targets.any {
                                it.id == state.selectedTargetId && it.available
                            },
                            onClick = onHoldToTalk,
                        ),
                ) {
                    Text(
                        "HOLD\nTO TALK",
                        color = Muted,
                        fontSize = 9.sp,
                        textAlign = TextAlign.Center,
                        fontWeight = FontWeight.Bold,
                    )
                }
                Surface(shape = RoundedCornerShape(12.dp), color = SurfaceInk) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        modifier = Modifier.fillMaxWidth().padding(8.dp),
                    ) {
                        Text(
                            latest?.respondingTarget?.ifBlank { latest.targetId } ?: "No reply",
                            color = Accent,
                            fontSize = 10.sp,
                        )
                        Text(
                            latest?.replyText?.take(100) ?: state.connectionDetail,
                            color = Ink,
                            fontSize = 11.sp,
                            textAlign = TextAlign.Center,
                        )
                        if (latest?.replyText?.isNotBlank() == true) {
                            when (latest.playbackPhase) {
                                PlaybackPhase.PLAYING -> TinyButton("Stop", onStop)
                                PlaybackPhase.STOPPED, PlaybackPhase.PLAYED,
                                PlaybackPhase.SKIPPED, PlaybackPhase.FAILED ->
                                    TinyButton("Replay", onReplay)
                                else -> TinyButton("Play", onPlay)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun TinyButton(label: String, action: () -> Unit) {
    Button(onClick = action, modifier = Modifier.size(width = 72.dp, height = 36.dp)) {
        Text(label, fontSize = 10.sp)
    }
}

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.CONNECTED -> "Connected"
    ConnectionState.CONNECTING -> "Connecting"
    ConnectionState.DISCONNECTED -> "Disconnected"
    ConnectionState.CONFIGURATION_REQUIRED -> "Pairing unavailable"
    ConnectionState.OFF -> "Off"
}
