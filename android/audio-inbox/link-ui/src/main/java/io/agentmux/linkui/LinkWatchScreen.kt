package io.agentmux.linkui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.adelost.designkit.ui.CircleSurfaceClass
import com.adelost.designkit.ui.GraphiteTokens
import com.adelost.designkit.ui.RingIcons
import com.adelost.releasekit.ui.releaseUpdateRows
import com.adelost.ringkit.ui.RenderRingScreen
import com.adelost.ringkit.ui.BackRing
import com.adelost.ringkit.ui.RingNavigator
import com.adelost.ringkit.ui.RingScreen
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkRecoveryPhase
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.LinkUpdateOperation
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.linkConnectionLabel
import io.agentmux.linkui.product.LinkConversationPresentation
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes
import io.agentmux.linkui.product.LinkPlaybackCommandEvent
import io.agentmux.linkui.product.LinkPlaybackPresentation
import io.agentmux.linkui.product.LinkProductGraph
import io.agentmux.linkui.product.LinkRecoveryPresentation
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.LinkRouteOpenEvent
import io.agentmux.linkui.product.LinkSessionPresentation
import io.agentmux.linkui.product.LinkTargetPresentation
import io.agentmux.linkui.product.LinkTargetSelectEvent
import io.agentmux.linkui.product.LinkUpdateCommandEvent
import io.agentmux.linkui.product.LinkUpdatePresentation
import io.agentmux.linkui.product.generated.GeneratedLinkHomeComponent
import io.agentmux.linkui.product.generated.GeneratedLinkHomeComponents
import io.agentmux.linkui.product.generated.GeneratedLinkSettingsComponent
import io.agentmux.linkui.product.generated.GeneratedLinkSettingsComponents
import kotlinx.coroutines.flow.MutableStateFlow
import java.time.ZoneId
import java.util.Locale

@Composable
fun LinkWatchScreen(
    graph: LinkProductGraph,
    currentVersionName: String,
    onRequestMicrophone: () -> Unit,
    recordedBytes: () -> Long,
    recordedLevel: () -> Float,
    onOpenDevHost: (() -> Unit)? = null,
) {
    LinkWatchSurface(
        graph = graph,
        currentVersionName = currentVersionName,
        onRequestMicrophone = onRequestMicrophone,
        recordedBytes = recordedBytes,
        recordedLevel = recordedLevel,
        onOpenDevHost = onOpenDevHost,
    )
}

/** The exact Watch presentation shared by real Wear and Phone WatchExact. */
@Composable
fun LinkWatchSurface(
    graph: LinkProductGraph,
    currentVersionName: String,
    onRequestMicrophone: () -> Unit,
    recordedBytes: () -> Long,
    recordedLevel: () -> Float,
    onOpenDevHost: (() -> Unit)? = null,
) {
    val route by graph.activePage.collectAsState()
    val target by graph.target.collectAsState()
    val capture by graph.capture.collectAsState()
    val captureSpec by graph.captureSpec.collectAsState()
    val latest by graph.latest.collectAsState()
    val connection by graph.connection.collectAsState()
    val updates by graph.updates.collectAsState()
    val recovery by graph.recovery.collectAsState()
    val showingSettings = route == LinkRoute.SETTINGS
    var captureOpen by remember { mutableStateOf(false) }
    var recipientOpen by remember { mutableStateOf(false) }
    var captureStarted by remember { mutableStateOf(false) }
    BackHandler(enabled = captureOpen) {
        graph.cancelCapture()
        captureStarted = false
        captureOpen = false
    }
    LaunchedEffect(capture.phase) {
        if (capture.phase == CapturePhase.LISTENING || capture.phase == CapturePhase.FINALIZING) {
            captureStarted = true
        } else if (captureStarted && capture.phase == CapturePhase.IDLE) {
            captureStarted = false
            captureOpen = false
        }
    }
    if (captureOpen) {
        Box(
            modifier = Modifier.fillMaxSize().background(GraphiteTokens.Canvas),
            contentAlignment = Alignment.Center,
        ) {
            LinkCaptureControl(
                spec = captureSpec,
                recordedBytes = recordedBytes,
                recordedLevel = recordedLevel,
                onBegin = graph::beginCapture,
                onRelease = graph::releaseCapture,
                onCancel = graph::cancelCapture,
                onRecover = onRequestMicrophone,
            )
            BackRing(label = "Back", onBack = {
                graph.cancelCapture()
                captureStarted = false
                captureOpen = false
            }, modifier = Modifier.align(Alignment.TopCenter))
        }
        return
    }
    if (recipientOpen) {
        LinkRecipientPicker(target, onSelect = {
            graph.onTargetSelect(LinkTargetSelectEvent(it))
            recipientOpen = false
        }, onBack = { recipientOpen = false })
        return
    }
    BackHandler(enabled = showingSettings) { check(graph.navigation.back()) }
    val onOpenSettings = remember(graph) {
        { graph.onSettingsActionOpen(LinkRouteOpenEvent(LinkRoute.SETTINGS)) }
    }
    // The body ends in a safe-call, so its natural type is `() -> Unit?`: "there
    // was no turn to play" is not a value a row handler may return. Stating the
    // contract here makes the compiler coerce it, instead of letting the
    // nullability travel into every call site.
    val onPlay: () -> Unit = remember(graph) {
        {
            graph.latest.value.turns.lastOrNull { it.replyText.isNotBlank() }?.turnId?.let { turnId ->
                graph.onActivePlaybackCommand(LinkPlaybackCommandEvent(PlaybackOperation.PLAY, turnId))
            }
        }
    }
    val onStop: () -> Unit = remember(graph) {
        {
            (
                graph.activePlayback.value.activeTurnId
                    ?: graph.latest.value.turns.lastOrNull { it.replyText.isNotBlank() }?.turnId
                )?.let { turnId ->
                graph.onActivePlaybackCommand(LinkPlaybackCommandEvent(PlaybackOperation.STOP, turnId))
            }
        }
    }
    val items = remember { MutableStateFlow(emptyList<RowSpec>()) }
    val navigator = remember(showingSettings) {
        RingNavigator(
            RingScreen.Rows(
                title = GeneratedLinkRoutes.descriptor(route).title,
                items = items,
                showBack = showingSettings,
            ),
        )
    }
    LaunchedEffect(
        target,
        latest,
        connection,
        updates,
        recovery,
        currentVersionName,
        showingSettings,
        route,
        onOpenDevHost,
        graph,
    ) {
        items.value = if (showingSettings) {
            linkWatchSettingsRows(
                session = connection,
                updates = updates,
                recovery = recovery,
                currentVersionName = currentVersionName,
                onCheckUpdate = {
                    graph.onUpdatesCommand(LinkUpdateCommandEvent(LinkUpdateOperation.RETRY))
                },
                onInstallUpdate = {
                    graph.onUpdatesCommand(LinkUpdateCommandEvent(LinkUpdateOperation.INSTALL))
                },
                onOpenDevHost = onOpenDevHost,
            )
        } else {
            linkWatchRows(
                target = target,
                conversation = latest,
                session = connection,
                onOpenRecipients = { recipientOpen = true },
                onOpenCapture = { captureOpen = true },
                onPlay = onPlay,
                onStop = onStop,
                onReplay = onPlay,
                onOpenSettings = onOpenSettings,
            )
        }
    }
    RenderRingScreen(nav = navigator, backLabel = "Back", onExit = { graph.navigation.back() })
}

fun linkWatchRows(
    target: LinkTargetPresentation,
    conversation: LinkConversationPresentation,
    session: LinkSessionPresentation,
    onOpenRecipients: () -> Unit,
    onOpenCapture: () -> Unit,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
    onOpenSettings: () -> Unit = {},
): List<RowSpec> {
    val selected = target.targets.firstOrNull { it.id == target.selectedTargetId }
    val rows = mutableListOf<RowSpec>()
    GeneratedLinkHomeComponents.resolve(CircleSurfaceClass.ROUND).orderedMounts.forEach { mount ->
        when (mount.component) {
            GeneratedLinkHomeComponent.NAVIGATION_PAGE_HOST -> Unit
            GeneratedLinkHomeComponent.TARGET_PICKER ->
                rows += linkRecipientRow(target, onOpenRecipients).copy(key = mount.id)
            GeneratedLinkHomeComponent.CAPTURE_TALK -> rows += RowSpec(
                key = mount.id,
                title = "VOICE MESSAGE",
                sub = if (selected == null) "Choose a recipient first" else "Hold to talk on the next screen",
                icon = LinkNativeBindings.requireIcon("record"),
                onTap = onOpenCapture.takeIf { selected?.acceptsMessages == true },
            )
            GeneratedLinkHomeComponent.CONVERSATION_LATEST -> rows += watchReplyRows(
                latest = conversation.turns.lastOrNull { it.targetId == target.selectedTargetId },
                defaultIcon = LinkNativeBindings.requireIcon("speaker"),
                onPlay = onPlay,
                onStop = onStop,
                onReplay = onReplay,
            )
            GeneratedLinkHomeComponent.NAVIGATION_SETTINGS_ENTRY -> rows += linkSettingsRow(onOpenSettings)
            GeneratedLinkHomeComponent.CONVERSATION_COMPOSER ->
                error("${mount.component.id.wireId} is not a Link home component on round")
        }
    }
    return rows
}

private fun watchReplyRows(
    latest: LinkTurn?,
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
    session: LinkSessionPresentation,
    updates: LinkUpdatePresentation,
    recovery: LinkRecoveryPresentation,
    currentVersionName: String,
    onCheckUpdate: () -> Unit = {},
    onInstallUpdate: () -> Unit = {},
    onOpenDevHost: (() -> Unit)? = null,
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): List<RowSpec> = buildList {
    GeneratedLinkSettingsComponents.resolve(CircleSurfaceClass.ROUND).orderedMounts.forEach { mount ->
        when (mount.component) {
            GeneratedLinkSettingsComponent.NAVIGATION_PAGE_HOST -> Unit
            GeneratedLinkSettingsComponent.SESSION_CONNECTION -> add(
                RowSpec(
                    key = mount.id,
                    title = linkConnectionLabel(session.connection),
                    sub = linkSessionSettingsDetail(session),
                    icon = if (session.connection == ConnectionState.CONNECTED) {
                        LinkNativeBindings.requireIcon("wifi")
                    } else {
                        LinkNativeBindings.requireIcon("link")
                    },
                ),
            )
            GeneratedLinkSettingsComponent.UPDATES_PANEL -> addAll(
                releaseUpdateRows(
                    state = updates.update,
                    currentVersionName = currentVersionName,
                    onCheck = onCheckUpdate,
                    onInstall = onInstallUpdate,
                    zoneId = zoneId,
                    locale = locale,
                ),
            )
            GeneratedLinkSettingsComponent.NAVIGATION_DEV_HOST_ENTRY -> onOpenDevHost?.let { open ->
                add(
                    RowSpec(
                        mount.id,
                        "DEV HOST",
                        "RESPONSIVE · WATCH EXACT",
                        LinkNativeBindings.requireIcon("phone"),
                        onTap = open,
                    ),
                )
            }
            GeneratedLinkSettingsComponent.RECOVERY_STATUS -> if (recovery.phase == LinkRecoveryPhase.QUARANTINED) {
                add(
                    RowSpec(
                        mount.id,
                        "RECOVERY",
                        recovery.detail.orEmpty().uppercase(),
                        LinkNativeBindings.requireIcon("warning"),
                    ),
                )
            }
            else -> error("${mount.component.id.wireId} is not a Link settings component on round")
        }
    }
}

/** The turn the playback service is actively driving; null once it stops or fails. */
val LinkPlaybackPresentation.activeTurnId: String?
    get() = turnId?.takeIf { phase == PlaybackPhase.PLAYING || phase == PlaybackPhase.PAUSED }

fun linkSessionRoute(session: LinkSessionPresentation): String {
    val detail = session.connectionDetail.orEmpty()
    return when {
        session.connection != ConnectionState.CONNECTED -> linkConnectionLabel(session.connection)
        detail.contains("public", ignoreCase = true) &&
            !detail.contains("tailscale", ignoreCase = true) -> "PUBLIC"
        else -> "PRIVATE"
    }
}

fun linkSessionSettingsDetail(session: LinkSessionPresentation): String =
    when (session.connection) {
        ConnectionState.CONNECTED ->
            session.connectionDetail.orEmpty().uppercase().take(42).ifBlank { "READY" }
        ConnectionState.CONNECTING -> "LOOKING FOR LINK"
        ConnectionState.DISCONNECTED -> "OPEN PHONE TO CONNECT"
        ConnectionState.CONFIGURATION_REQUIRED -> "LOG IN ON PHONE"
        ConnectionState.OFF -> "LINK IS OFF"
    }
