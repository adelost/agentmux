package io.agentmux.audioinbox.wear

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.activity.compose.BackHandler
import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.ui.RenderRingScreen
import com.adelost.ringkit.ui.RingNavigator
import com.adelost.ringkit.ui.RingScreen
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.linkConnectionLabel
import io.agentmux.linkcore.linkConnectionRoute
import io.agentmux.linkcore.linkConnectionSettingsDetail
import kotlinx.coroutines.flow.MutableStateFlow

@Composable
internal fun WearLinkScreen(
    state: LinkState,
    onSelectTarget: (String) -> Unit,
    onBeginCapture: () -> Boolean,
    onReleaseCapture: () -> Unit,
    onCancelCapture: () -> Unit,
    recordedBytes: () -> Long,
    recordedLevel: () -> Float,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
) {
    var captureOpen by remember { mutableStateOf(false) }
    var captureStarted by remember { mutableStateOf(false) }
    BackHandler(enabled = captureOpen) {
        onCancelCapture()
        captureStarted = false
        captureOpen = false
    }
    LaunchedEffect(state.capture) {
        if (state.capture == io.agentmux.linkcore.CapturePhase.LISTENING ||
            state.capture == io.agentmux.linkcore.CapturePhase.FINALIZING
        ) {
            captureStarted = true
        } else if (captureStarted &&
            state.capture == io.agentmux.linkcore.CapturePhase.IDLE
        ) {
            captureStarted = false
            captureOpen = false
        }
    }
    if (captureOpen) {
        WearCaptureScreen(
            phase = state.capture,
            recordedBytes = recordedBytes,
            recordedLevel = recordedLevel,
            onBegin = onBeginCapture,
            onRelease = onReleaseCapture,
            onCancel = onCancelCapture,
        )
        return
    }
    val items = remember { MutableStateFlow(emptyList<RowSpec>()) }
    val settingsItems = remember { MutableStateFlow(emptyList<RowSpec>()) }
    val navigator = remember {
        RingNavigator(
            RingScreen.Rows(
                title = "AGENTMUX LINK",
                items = items,
                showBack = false,
            ),
        )
    }
    LaunchedEffect(state, onSelectTarget, onPlay, onStop, onReplay) {
        settingsItems.value = wearLinkSettingsRows(state)
        items.value = wearLinkRows(
            state = state,
            onSelectTarget = onSelectTarget,
            onOpenCapture = { captureOpen = true },
            onPlay = onPlay,
            onStop = onStop,
            onReplay = onReplay,
            onSettings = {
                navigator.push(
                    RingScreen.Rows(
                        title = "LINK SETTINGS",
                        items = settingsItems,
                        showBack = true,
                    ),
                )
            },
        )
    }
    RenderRingScreen(nav = navigator, onExit = {})
}

internal fun wearLinkRows(
    state: LinkState,
    onSelectTarget: (String) -> Unit,
    onOpenCapture: () -> Unit,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
    onSettings: () -> Unit = {},
): List<RowSpec> {
    val selected = state.targets.firstOrNull { it.id == state.selectedTargetId }
        ?: state.targets.firstOrNull()
    val availableTargets = state.targets.filter { it.available }
    val targetChoices = availableTargets
        .map { it.label.ifBlank { it.id }.uppercase() }
        .takeIf { it.size >= 2 }
        .orEmpty()
    val latest = state.turns.lastOrNull()
    val selectedAvailable = selected?.available == true
    val rows = mutableListOf(
        RowSpec(
            key = "target",
            title = "AGENT · ${linkConnectionRoute(state)}",
            sub = selected?.label?.ifBlank { selected.id }?.uppercase() ?: "NO TARGET",
            icon = RingIcons.Target,
            choices = targetChoices,
            onSelect = if (targetChoices.isEmpty()) {
                null
            } else {
                { label ->
                    availableTargets.firstOrNull {
                        it.label.ifBlank { it.id }.uppercase() == label
                    }?.let { onSelectTarget(it.id) }
                }
            },
        ),
        RowSpec(
            key = "talk",
            title = "PUSH TO TALK",
            sub = if (selectedAvailable) "OPEN RECORDER" else "UNAVAILABLE",
            icon = RingIcons.Record,
            onTap = onOpenCapture.takeIf { selectedAvailable },
        ),
    )
    if (latest == null) {
        rows += RowSpec(
            key = "latest",
            title = "LATEST REPLY",
            sub = "NO REPLY YET",
            icon = RingIcons.Speaker,
        )
        rows += settingsRow(onSettings)
        return rows
    }
    rows += RowSpec(
        key = "latest",
        title = latest.respondingTarget.ifBlank { latest.targetId }.uppercase(),
        sub = when {
            latest.replyText.isNotBlank() -> latest.replyText
            latest.deliveryPhase == DeliveryPhase.FAILED ->
                latest.deliveryError.ifBlank { "DELIVERY FAILED" }
            else -> "WAITING FOR REPLY"
        }.uppercase().take(54),
        icon = RingIcons.Speaker,
    )
    if (latest.replyText.isNotBlank()) {
        rows += when (latest.playbackPhase) {
            PlaybackPhase.PLAYING -> RowSpec(
                key = "playback",
                title = "STOP REPLY",
                sub = "PLAYING",
                icon = RingIcons.Stop,
                onTap = onStop,
            )
            PlaybackPhase.STOPPED,
            PlaybackPhase.PLAYED,
            PlaybackPhase.SKIPPED,
            PlaybackPhase.FAILED,
            -> RowSpec(
                key = "playback",
                title = "REPLAY",
                sub = "PLAY LATEST REPLY",
                icon = RingIcons.Refresh,
                onTap = onReplay,
            )
            else -> RowSpec(
                key = "playback",
                title = "PLAY REPLY",
                sub = "LATEST RESPONSE",
                icon = RingIcons.Play,
                onTap = onPlay,
            )
        }
    }
    rows += settingsRow(onSettings)
    return rows
}

internal fun wearLinkSettingsRows(state: LinkState): List<RowSpec> = listOf(
    RowSpec(
        key = "connection",
        title = linkConnectionLabel(state.connection),
        sub = linkConnectionSettingsDetail(state),
        icon = if (state.connection == ConnectionState.CONNECTED) RingIcons.Wifi else RingIcons.Link,
    ),
)

private fun settingsRow(onSettings: () -> Unit) = RowSpec(
    key = "settings",
    title = "SETTINGS",
    sub = "CONNECTION & AUDIO",
    icon = RingIcons.Gear,
    onTap = onSettings,
)
