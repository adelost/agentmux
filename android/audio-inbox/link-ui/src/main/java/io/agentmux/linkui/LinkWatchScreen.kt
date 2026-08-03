package io.agentmux.linkui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.adelost.designkit.ui.GraphiteTokens
import com.adelost.designkit.ui.RingIcons
import com.adelost.releasekit.UpdateState
import com.adelost.releasekit.ui.releaseUpdateRows
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
import java.time.ZoneId
import java.util.Locale

@Composable
fun LinkWatchScreen(
    state: LinkState,
    updateState: UpdateState,
    currentVersionName: String,
    microphoneGranted: Boolean,
    onRequestMicrophone: () -> Unit,
    onSelectTarget: (String) -> Unit,
    onBeginCapture: () -> Boolean,
    onReleaseCapture: () -> Unit,
    onCancelCapture: () -> Unit,
    recordedBytes: () -> Long,
    recordedLevel: () -> Float,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
    onCheckUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onOpenDevHost: (() -> Unit)? = null,
    initialShowingSettings: Boolean = false,
) {
    var showingSettings by rememberSaveable { mutableStateOf(initialShowingSettings) }
    LinkWatchSurface(
        state = state,
        updateState = updateState,
        currentVersionName = currentVersionName,
        showingSettings = showingSettings,
        onMenuAction = { action -> action.dispatch { showingSettings = true } },
        onBack = { showingSettings = false },
        microphoneGranted = microphoneGranted,
        onRequestMicrophone = onRequestMicrophone,
        onSelectTarget = onSelectTarget,
        onBeginCapture = onBeginCapture,
        onReleaseCapture = onReleaseCapture,
        onCancelCapture = onCancelCapture,
        recordedBytes = recordedBytes,
        recordedLevel = recordedLevel,
        onPlay = onPlay,
        onStop = onStop,
        onReplay = onReplay,
        onCheckUpdate = onCheckUpdate,
        onInstallUpdate = onInstallUpdate,
        onOpenDevHost = onOpenDevHost,
    )
}

/** The exact Watch presentation shared by real Wear and Phone WatchExact. */
@Composable
fun LinkWatchSurface(
    state: LinkState,
    updateState: UpdateState,
    currentVersionName: String,
    showingSettings: Boolean,
    onMenuAction: (LinkMenuAction) -> Unit,
    onBack: () -> Unit,
    microphoneGranted: Boolean,
    onRequestMicrophone: () -> Unit,
    onSelectTarget: (String) -> Unit,
    onBeginCapture: () -> Boolean,
    onReleaseCapture: () -> Unit,
    onCancelCapture: () -> Unit,
    recordedBytes: () -> Long,
    recordedLevel: () -> Float,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
    onCheckUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
    onOpenDevHost: (() -> Unit)? = null,
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
        val selected = state.targets.firstOrNull { it.id == state.selectedTargetId }
            ?: state.targets.firstOrNull()
        Box(
            modifier = Modifier.fillMaxSize().background(GraphiteTokens.Canvas),
            contentAlignment = Alignment.Center,
        ) {
            LinkCaptureControl(
                spec = LinkCaptureSpec(
                    phase = state.capture,
                    startedAtMs = state.captureStartedAtMs,
                    availability = resolveLinkCaptureAvailability(
                        hasTarget = selected != null,
                        targetAcceptsMessages = selected?.acceptsMessages == true,
                        microphoneGranted = microphoneGranted,
                        finalizing = state.capture == io.agentmux.linkcore.CapturePhase.FINALIZING,
                    ),
                ),
                recordedBytes = recordedBytes,
                recordedLevel = recordedLevel,
                onBegin = onBeginCapture,
                onRelease = onReleaseCapture,
                onCancel = onCancelCapture,
                onRecover = onRequestMicrophone,
            )
        }
        return
    }
    BackHandler(enabled = showingSettings) { onBack() }
    val items = remember { MutableStateFlow(emptyList<RowSpec>()) }
    val navigator = remember(showingSettings) {
        RingNavigator(
            RingScreen.Rows(
                title = if (showingSettings) "LINK SETTINGS" else "AGENTMUX LINK",
                items = items,
                showBack = showingSettings,
            ),
        )
    }
    LaunchedEffect(
        state,
        updateState,
        currentVersionName,
        onSelectTarget,
        onPlay,
        onStop,
        onReplay,
        onCheckUpdate,
        onInstallUpdate,
        onOpenDevHost,
        showingSettings,
        onMenuAction,
    ) {
        items.value = if (showingSettings) {
            linkWatchSettingsRows(
                state = state,
                updateState = updateState,
                currentVersionName = currentVersionName,
                onCheckUpdate = onCheckUpdate,
                onInstallUpdate = onInstallUpdate,
                onOpenDevHost = onOpenDevHost,
            )
        } else {
            linkWatchRows(
                state = state,
                onSelectTarget = onSelectTarget,
                onOpenCapture = { captureOpen = true },
                onPlay = onPlay,
                onStop = onStop,
                onReplay = onReplay,
                onMenuAction = onMenuAction,
            )
        }
    }
    RenderRingScreen(nav = navigator, onExit = onBack)
}

fun linkWatchRows(
    state: LinkState,
    onSelectTarget: (String) -> Unit,
    onOpenCapture: () -> Unit,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
    onMenuAction: (LinkMenuAction) -> Unit = {},
): List<RowSpec> {
    val selected = state.targets.firstOrNull { it.id == state.selectedTargetId }
        ?: state.targets.firstOrNull()
    val sendableTargets = state.targets.filter { it.acceptsMessages }
    val targetChoices = sendableTargets
        .map { it.label.ifBlank { it.id }.uppercase() }
        .takeIf { it.size >= 2 }
        .orEmpty()
    val latest = state.turns.lastOrNull()
    val selectedSendable = selected?.acceptsMessages == true
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
                    sendableTargets.firstOrNull {
                        it.label.ifBlank { it.id }.uppercase() == label
                    }?.let { onSelectTarget(it.id) }
                }
            },
        ),
        RowSpec(
            key = "talk",
            title = "PUSH TO TALK",
            sub = when {
                !selectedSendable -> "UNAVAILABLE"
                selected?.available == false -> "OPEN RECORDER · WILL QUEUE"
                else -> "OPEN RECORDER"
            },
            icon = RingIcons.Record,
            onTap = onOpenCapture.takeIf { selectedSendable },
        ),
    )
    if (latest == null) {
        rows += RowSpec(
            key = "latest",
            title = "LATEST REPLY",
            sub = "NO REPLY YET",
            icon = RingIcons.Speaker,
        )
        rows += linkSettingsRow(onMenuAction)
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
            PlaybackPhase.FAILED -> RowSpec(
                key = "playback",
                title = "RETRY PLAYBACK",
                sub = latest.playbackError.ifBlank { "PLAYBACK FAILED" }.uppercase().take(54),
                icon = RingIcons.Refresh,
                onTap = onReplay,
            )
            PlaybackPhase.STOPPED,
            PlaybackPhase.PLAYED,
            PlaybackPhase.SKIPPED,
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
    rows += linkSettingsRow(onMenuAction)
    return rows
}

fun linkWatchSettingsRows(
    state: LinkState,
    updateState: UpdateState,
    currentVersionName: String,
    onCheckUpdate: () -> Unit = {},
    onInstallUpdate: () -> Unit = {},
    onOpenDevHost: (() -> Unit)? = null,
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): List<RowSpec> = buildList {
    add(
        RowSpec(
            key = "connection",
            title = linkConnectionLabel(state.connection),
            sub = linkConnectionSettingsDetail(state),
            icon = if (state.connection == ConnectionState.CONNECTED) RingIcons.Wifi else RingIcons.Link,
        ),
    )
    addAll(
        releaseUpdateRows(
            state = updateState,
            currentVersionName = currentVersionName,
            onCheck = onCheckUpdate,
            onInstall = onInstallUpdate,
            zoneId = zoneId,
            locale = locale,
        ),
    )
    onOpenDevHost?.let { open ->
        add(
            RowSpec(
                key = "dev-host",
                title = "DEV HOST",
                sub = "RESPONSIVE · WATCH EXACT",
                icon = RingIcons.Phone,
                onTap = open,
            ),
        )
    }
}
