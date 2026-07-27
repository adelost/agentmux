package io.agentmux.audioinbox

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.ConnectionState

@Composable
internal fun LinkPhoneScreen(
    coordinator: LinkCoordinator,
    recorder: PushToTalkRecorder,
    updater: AppUpdater,
) {
    val state by coordinator.state.collectAsStateWithLifecycle()
    var composer by remember { mutableStateOf("") }
    var speakReplies by remember { mutableStateOf(coordinator.speaksReplies()) }
    val canSend = composer.isNotBlank() && coordinator.selectedTarget()?.available == true
    LaunchedEffect(coordinator) {
        coordinator.acceptedDrafts.collect { accepted ->
            if (composer == accepted.draft) composer = ""
        }
    }
    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = LinkTokens.PageGutter, vertical = 20.dp),
    ) {
        Header(state.connection, state.connectionDetail)
        if (state.recoveryError.isNotBlank()) {
            Surface(shape = RoundedCornerShape(12.dp), color = LinkTokens.SurfaceStrong) {
                Text(
                    state.recoveryError,
                    color = LinkTokens.Error,
                    modifier = Modifier.fillMaxWidth().padding(12.dp),
                )
            }
        }
        TargetChooser(
            targets = state.targets,
            selected = state.selectedTargetId,
            onSelect = coordinator::selectTarget,
        )
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = LinkTokens.Surface,
            border = BorderStroke(1.dp, LinkTokens.Border),
        ) {
            Column(
                verticalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier.fillMaxWidth().padding(14.dp),
            ) {
                Text("Conversation", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                ConversationTimeline(
                    turns = state.turns,
                    onPlay = coordinator::playReply,
                    onPause = coordinator::pauseAudio,
                    onStop = coordinator::stopAudio,
                )
                Row(
                    verticalAlignment = Alignment.Bottom,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = composer,
                        onValueChange = { if (it.length <= 4000) composer = it },
                        label = { Text("Type another message") },
                        minLines = 1,
                        maxLines = 4,
                        modifier = Modifier.weight(1f),
                    )
                    CircularControl(
                        diameter = 52.dp,
                        active = canSend,
                        modifier = Modifier
                            .clickable(enabled = canSend) { coordinator.submitText(composer) }
                            .semantics { contentDescription = "Send message" },
                    ) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.Send,
                            contentDescription = null,
                            tint = if (canSend) LinkTokens.AccentInk else LinkTokens.Ink,
                            modifier = Modifier
                                .fillMaxSize()
                                .padding(14.dp)
                                .then(
                                    Modifier.semantics { contentDescription = "Send message" },
                                ),
                        )
                    }
                }
            }
        }
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxWidth(),
        ) {
            PttDisc(
                phase = state.capture,
                startedAtMs = state.captureStartedAtMs,
                enabled = coordinator.selectedTarget()?.available == true,
                onBegin = {
                    val capture = recorder.begin()
                    if (capture == null) false
                    else {
                        coordinator.capture(CapturePhase.LISTENING, capture.startedAtMs)
                        true
                    }
                },
                onRelease = {
                    coordinator.capture(CapturePhase.FINALIZING)
                    val capture = recorder.release()
                    if (capture != null && coordinator.submitAudio(capture)) {
                        coordinator.capture(CapturePhase.IDLE)
                    } else {
                        coordinator.capture(CapturePhase.FAILED)
                    }
                },
                onCancel = {
                    recorder.cancel()
                    coordinator.capture(CapturePhase.FAILED)
                },
            )
            Text(captureStatus(state.capture), color = LinkTokens.Muted)
        }
        val audioActive = state.activePlaybackTurnId != null ||
            state.connectionDetail.startsWith("Playing", ignoreCase = true)
        if (audioActive) {
            Button(
                onClick = coordinator::stopAudio,
                colors = ButtonDefaults.buttonColors(
                    containerColor = LinkTokens.Error,
                    contentColor = Color.White,
                ),
                modifier = Modifier.fillMaxWidth().height(52.dp),
            ) {
                Text("■ STOP AUDIO", fontWeight = FontWeight.Bold)
            }
        }
        SettingsRow(
            handsFree = state.handsFree,
            speakReplies = speakReplies,
            onHandsFree = coordinator::setHandsFree,
            onSpeak = {
                speakReplies = it
                coordinator.setSpeakReplies(it)
            },
        )
        UpdateCard(
            update = state.update,
            onInstall = updater::install,
            onRetry = updater::retry,
        )
        Spacer(Modifier.height(24.dp))
    }
}

@Composable
private fun Header(connection: ConnectionState, detail: String) {
    Row(
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column {
            Text("PRIVATE AGENT LINK", color = LinkTokens.Accent, fontSize = 11.sp)
            Text("Agentmux Link", color = LinkTokens.Ink, fontSize = 30.sp, fontWeight = FontWeight.Bold)
        }
        Surface(shape = CircleShape, color = LinkTokens.SurfaceStrong) {
            Text(
                text = "● ${connectionLabel(connection)}",
                color = connectionColor(connection),
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            )
        }
    }
    Text(detail, color = LinkTokens.Muted, fontSize = 12.sp)
}

@Composable
private fun TargetChooser(
    targets: List<io.agentmux.linkcore.LinkTarget>,
    selected: String,
    onSelect: (String) -> Unit,
) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
    ) {
        targets.forEach { target ->
            Button(
                onClick = { onSelect(target.id) },
                enabled = target.available,
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (target.id == selected) LinkTokens.Accent
                    else LinkTokens.SurfaceStrong,
                    contentColor = if (target.id == selected) LinkTokens.AccentInk
                    else LinkTokens.Ink,
                ),
            ) {
                Text(if (target.label == target.id) target.id else "${target.label} · ${target.id}")
            }
        }
    }
}

@Composable
private fun SettingsRow(
    handsFree: Boolean,
    speakReplies: Boolean,
    onHandsFree: (Boolean) -> Unit,
    onSpeak: (Boolean) -> Unit,
) {
    Surface(shape = RoundedCornerShape(14.dp), color = LinkTokens.Surface) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            ToggleRow("Hands-free broadcasts", handsFree, onHandsFree)
            ToggleRow("Read direct replies aloud", speakReplies, onSpeak)
        }
    }
}

@Composable
private fun ToggleRow(label: String, checked: Boolean, onChecked: (Boolean) -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChecked)
    }
}

private fun captureStatus(phase: CapturePhase): String = when (phase) {
    CapturePhase.IDLE -> "Hold while speaking · release sends"
    CapturePhase.LISTENING -> "Listening"
    CapturePhase.FINALIZING -> "Sending"
    CapturePhase.FAILED -> "Recording or send failed"
}

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.CONNECTED -> "Connected"
    ConnectionState.CONNECTING -> "Connecting"
    ConnectionState.DISCONNECTED -> "Disconnected"
    ConnectionState.CONFIGURATION_REQUIRED -> "Setup"
    ConnectionState.OFF -> "Off"
}

private fun connectionColor(state: ConnectionState) = when (state) {
    ConnectionState.CONNECTED -> LinkTokens.Accent
    ConnectionState.CONNECTING -> LinkTokens.Warning
    ConnectionState.DISCONNECTED, ConnectionState.CONFIGURATION_REQUIRED -> LinkTokens.Error
    ConnectionState.OFF -> LinkTokens.Muted
}
