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
import io.agentmux.linkui.product.LinkNativeComponentRenderer
import io.agentmux.linkui.product.LinkProductSession
import io.agentmux.linkui.product.generated.LinkMenuAction
import io.agentmux.linkui.product.generated.LinkRoute
import kotlinx.coroutines.flow.MutableStateFlow
import java.time.ZoneId
import java.util.Locale

@Composable
fun LinkWatchScreen(
    product: LinkProductSession,
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
    var route by rememberSaveable {
        mutableStateOf(if (initialShowingSettings) LinkRoute.SETTINGS else LinkRoute.HOME)
    }
    LinkWatchSurface(
        product = product,
        state = state,
        updateState = updateState,
        currentVersionName = currentVersionName,
        route = route,
        onNavigate = { route = it },
        onBack = { route = LinkRoute.HOME },
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
    product: LinkProductSession,
    state: LinkState,
    updateState: UpdateState,
    currentVersionName: String,
    route: LinkRoute,
    onNavigate: (LinkRoute) -> Unit,
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
    val showingSettings = route == LinkRoute.SETTINGS
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
                title = product.route(route).title,
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
        onNavigate,
    ) {
        items.value = if (showingSettings) {
            linkWatchSettingsRows(
                product = product,
                state = state,
                updateState = updateState,
                currentVersionName = currentVersionName,
                onCheckUpdate = onCheckUpdate,
                onInstallUpdate = onInstallUpdate,
                onOpenDevHost = onOpenDevHost,
            )
        } else {
            linkWatchRows(
                product = product,
                state = state,
                onSelectTarget = onSelectTarget,
                onOpenCapture = { captureOpen = true },
                onPlay = onPlay,
                onStop = onStop,
                onReplay = onReplay,
                onMenuAction = { action -> action.dispatch(product, onNavigate) },
            )
        }
    }
    RenderRingScreen(nav = navigator, onExit = onBack)
}

fun linkWatchRows(
    product: LinkProductSession,
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
    val rows = mutableListOf<RowSpec>()
    product.components(LinkRoute.HOME, "round").forEach { component ->
        when (component.renderer) {
            LinkNativeComponentRenderer.STATUS -> rows += RowSpec(
                key = component.componentId,
                title = "AGENT · ${linkConnectionRoute(state)}",
                sub = selected?.label?.ifBlank { selected.id }?.uppercase() ?: "NO TARGET",
                icon = product.icon(component),
                choices = targetChoices,
                onSelect = targetChoices.takeIf { it.isNotEmpty() }?.let {
                    { label: String ->
                        sendableTargets.firstOrNull {
                            it.label.ifBlank { it.id }.uppercase() == label
                        }?.let { onSelectTarget(it.id) }
                    }
                },
            )
            LinkNativeComponentRenderer.CAPTURE -> rows += RowSpec(
                key = component.componentId,
                title = "PUSH TO TALK",
                sub = when {
                    !selectedSendable -> "UNAVAILABLE"
                    selected?.available == false -> "OPEN RECORDER · WILL QUEUE"
                    else -> "OPEN RECORDER"
                },
                icon = product.icon(component),
                onTap = onOpenCapture.takeIf { selectedSendable },
            )
            LinkNativeComponentRenderer.CONVERSATION_FEED -> rows += watchReplyRows(
                latest = latest,
                defaultIcon = product.icon(component),
                onPlay = onPlay,
                onStop = onStop,
                onReplay = onReplay,
            )
            else -> error("${component.renderer.id} is not a Link home component on round")
        }
    }
    rows += linkSettingsRow(product, onMenuAction)
    return rows
}

private fun watchReplyRows(
    latest: io.agentmux.linkcore.LinkTurn?,
    defaultIcon: androidx.compose.ui.graphics.vector.ImageVector,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
): List<RowSpec> = buildList {
    if (latest == null) {
        add(RowSpec("latest", "LATEST REPLY", "NO REPLY YET", defaultIcon))
        return@buildList
    }
    add(
        RowSpec(
            key = "latest",
            title = latest.respondingTarget.ifBlank { latest.targetId }.uppercase(),
            sub = when {
                latest.replyText.isNotBlank() -> latest.replyText
                latest.deliveryPhase == DeliveryPhase.FAILED -> latest.deliveryError.ifBlank { "DELIVERY FAILED" }
                else -> "WAITING FOR REPLY"
            }.uppercase().take(54),
            icon = defaultIcon,
        ),
    )
    if (latest.replyText.isBlank()) return@buildList
    add(
        when (latest.playbackPhase) {
            PlaybackPhase.PLAYING -> RowSpec("playback", "STOP REPLY", "PLAYING", RingIcons.Stop, onTap = onStop)
            PlaybackPhase.FAILED -> RowSpec("playback", "RETRY PLAYBACK", latest.playbackError.ifBlank { "PLAYBACK FAILED" }.uppercase().take(54), RingIcons.Refresh, onTap = onReplay)
            PlaybackPhase.STOPPED, PlaybackPhase.PLAYED, PlaybackPhase.SKIPPED ->
                RowSpec("playback", "REPLAY", "PLAY LATEST REPLY", RingIcons.Refresh, onTap = onReplay)
            else -> RowSpec("playback", "PLAY REPLY", "LATEST RESPONSE", RingIcons.Play, onTap = onPlay)
        },
    )
}

fun linkWatchSettingsRows(
    product: LinkProductSession,
    state: LinkState,
    updateState: UpdateState,
    currentVersionName: String,
    onCheckUpdate: () -> Unit = {},
    onInstallUpdate: () -> Unit = {},
    onOpenDevHost: (() -> Unit)? = null,
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): List<RowSpec> = buildList {
    product.components(LinkRoute.SETTINGS, "round").forEach { component ->
        when (component.renderer) {
            LinkNativeComponentRenderer.CONNECTION -> add(
                RowSpec(
                    key = component.componentId,
                    title = linkConnectionLabel(state.connection),
                    sub = linkConnectionSettingsDetail(state),
                    icon = if (state.connection == ConnectionState.CONNECTED) RingIcons.Wifi else RingIcons.Link,
                ),
            )
            LinkNativeComponentRenderer.UPDATES -> addAll(
                releaseUpdateRows(
                    state = updateState,
                    currentVersionName = currentVersionName,
                    onCheck = onCheckUpdate,
                    onInstall = onInstallUpdate,
                    zoneId = zoneId,
                    locale = locale,
                ),
            )
            LinkNativeComponentRenderer.DEV_HOST -> onOpenDevHost?.let { open ->
                add(RowSpec(component.componentId, "DEV HOST", "RESPONSIVE · WATCH EXACT", product.icon(component), onTap = open))
            }
            LinkNativeComponentRenderer.RECOVERY -> state.recoveryError.takeIf { it.isNotBlank() }?.let { error ->
                add(RowSpec(component.componentId, "RECOVERY", error.uppercase(), product.icon(component)))
            }
            else -> error("${component.renderer.id} is not a Link settings component on round")
        }
    }
}
