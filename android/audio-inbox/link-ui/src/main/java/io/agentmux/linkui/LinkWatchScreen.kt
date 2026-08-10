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
import io.agentmux.linkui.product.generated.*
import kotlinx.coroutines.flow.MutableStateFlow
import java.time.ZoneId
import java.util.Locale

@Composable
fun LinkWatchScreen(
    graph: LinkProductGraph,
    onOpenDevHost: (() -> Unit)? = null,
) {
    LinkWatchSurface(
        graph = graph,
        onOpenDevHost = onOpenDevHost,
    )
}

/** The exact Watch presentation shared by real Wear and Phone WatchExact. */
@Composable
fun LinkWatchSurface(
    graph: LinkProductGraph,
    onOpenDevHost: (() -> Unit)? = null,
) {
    val route by graph.activePage.collectAsState()
    val target by graph.targetRenderInputs.collectAsState()
    val talk by graph.talkRenderInputs.collectAsState()
    val capture = talk.model
    val latest by graph.latestRenderInputs.collectAsState()
    val connection by graph.connectionRenderInputs.collectAsState()
    val updates by graph.updatesRenderInputs.collectAsState()
    val recovery by graph.recoveryRenderInputs.collectAsState()
    val showingSettings = route == LinkRoute.SETTINGS
    var captureOpen by remember { mutableStateOf(false) }
    var captureStarted by remember { mutableStateOf(false) }
    BackHandler(enabled = captureOpen) {
        graph.talkRenderEmitter.command(io.agentmux.linkui.product.LinkCaptureCommandEvent(
            io.agentmux.linkcore.CaptureOperation.CANCEL,
        ))
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
                inputs = talk,
                emitter = graph.talkRenderEmitter,
            )
        }
        return
    }
    BackHandler(enabled = showingSettings) { check(graph.navigation.back()) }
    val onOpenSettings = remember(graph) {
        { graph.onSettingsActionOpen(LinkRouteOpenEvent(LinkRoute.SETTINGS)) }
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
        updates.model.currentVersionName,
        showingSettings,
        route,
        onOpenDevHost,
        graph,
    ) {
        items.value = if (showingSettings) {
            linkWatchSettingsRows(
                connection = connection,
                updates = updates,
                updateEmitter = graph.updatesRenderEmitter,
                recovery = recovery,
                onOpenDevHost = onOpenDevHost,
            )
        } else {
            linkWatchRows(
                target = target,
                targetEmitter = graph.targetRenderEmitter,
                latest = latest,
                latestEmitter = graph.latestRenderEmitter,
                onOpenCapture = { captureOpen = true },
                onOpenSettings = onOpenSettings,
            )
        }
    }
    RenderRingScreen(nav = navigator, onExit = { graph.navigation.back() })
}

fun linkWatchRows(
    target: GeneratedTargetRenderInputs,
    targetEmitter: GeneratedTargetRenderEmitter,
    latest: GeneratedLatestRenderInputs,
    latestEmitter: GeneratedLatestRenderEmitter,
    onOpenCapture: () -> Unit,
    onOpenSettings: () -> Unit = {},
): List<RowSpec> {
    val selected = target.model.targets.firstOrNull { it.id == target.model.selectedTargetId }
    val rows = mutableListOf<RowSpec>()
    GeneratedLinkHomeComponents.resolve(CircleSurfaceClass.ROUND).orderedMounts.forEach { mount ->
        when (mount.component) {
            GeneratedLinkHomeComponent.PAGE_HOST -> Unit
            GeneratedLinkHomeComponent.TARGET -> rows += WearTargetRenderer(target, targetEmitter)
            GeneratedLinkHomeComponent.TALK -> rows += RowSpec(
                key = mount.id,
                title = "PUSH TO TALK",
                sub = if (selected == null) "UNAVAILABLE" else "OPEN RECORDER",
                icon = LinkNativeBindings.requireIcon("record"),
                onTap = onOpenCapture.takeIf { selected != null },
            )
            GeneratedLinkHomeComponent.LATEST -> rows += WearLatestRenderer(latest, latestEmitter)
            GeneratedLinkHomeComponent.SETTINGS_ACTION -> rows += linkSettingsRow(onOpenSettings)
            GeneratedLinkHomeComponent.COMPOSER ->
                error("${mount.component.id.wireId} is not a Link home component on round")
        }
    }
    return rows
}

fun WearTargetRenderer(
    inputs: GeneratedTargetRenderInputs,
    emitter: GeneratedTargetRenderEmitter,
): RowSpec {
    val selected = inputs.model.targets.firstOrNull { it.id == inputs.model.selectedTargetId }
    val choices = inputs.model.targets.map { it.label.ifBlank { it.id }.uppercase() }.takeIf { it.size >= 2 }.orEmpty()
    return RowSpec(
        key = "target",
        title = "AGENT · ${linkSessionRoute(inputs.session)}",
        sub = selected?.label?.ifBlank { selected.id }?.uppercase() ?: "NO TARGET",
        icon = LinkNativeBindings.requireIcon("target"),
        choices = choices,
        onSelect = choices.takeIf { it.isNotEmpty() }?.let {
            { label -> inputs.model.targets.firstOrNull {
                it.label.ifBlank { it.id }.uppercase() == label
            }?.let { emitter.select(LinkTargetSelectEvent(it.id)) } }
        },
    )
}

fun WearLatestRenderer(
    inputs: GeneratedLatestRenderInputs,
    emitter: GeneratedLatestRenderEmitter,
): List<RowSpec> = watchReplyRows(
    inputs.model.turns.lastOrNull(), LinkNativeBindings.requireIcon("speaker"),
    onPlay = { inputs.model.turns.lastOrNull { it.replyText.isNotBlank() }?.turnId?.let {
        emitter.playbackCommand(LinkPlaybackCommandEvent(PlaybackOperation.PLAY, it))
    } },
    onStop = { (inputs.playback.activeTurnId
        ?: inputs.model.turns.lastOrNull { it.replyText.isNotBlank() }?.turnId)?.let {
        emitter.playbackCommand(LinkPlaybackCommandEvent(PlaybackOperation.STOP, it))
    } },
    onReplay = { inputs.model.turns.lastOrNull { it.replyText.isNotBlank() }?.turnId?.let {
        emitter.playbackCommand(LinkPlaybackCommandEvent(PlaybackOperation.PLAY, it))
    } },
)

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
    connection: GeneratedConnectionRenderInputs,
    updates: GeneratedUpdatesRenderInputs,
    updateEmitter: GeneratedUpdatesRenderEmitter,
    recovery: GeneratedRecoveryRenderInputs,
    onOpenDevHost: (() -> Unit)? = null,
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): List<RowSpec> = buildList {
    GeneratedLinkSettingsComponents.resolve(CircleSurfaceClass.ROUND).orderedMounts.forEach { mount ->
        when (mount.component) {
            GeneratedLinkSettingsComponent.PAGE_HOST -> Unit
            GeneratedLinkSettingsComponent.CONNECTION -> add(
                WearConnectionRenderer(connection, GeneratedConnectionRenderEmitter),
            )
            GeneratedLinkSettingsComponent.UPDATES -> addAll(
                wearUpdatesRows(updates, updateEmitter, zoneId, locale),
            )
            GeneratedLinkSettingsComponent.DEV_HOST -> onOpenDevHost?.let { open ->
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
            GeneratedLinkSettingsComponent.RECOVERY -> if (recovery.model.phase == LinkRecoveryPhase.QUARANTINED) {
                add(WearRecoveryRenderer(recovery, GeneratedRecoveryRenderEmitter))
            }
            else -> error("${mount.component.id.wireId} is not a Link settings component on round")
        }
    }
}

fun WearConnectionRenderer(
    inputs: GeneratedConnectionRenderInputs,
    emitter: GeneratedConnectionRenderEmitter,
): RowSpec = RowSpec(
    "connection", linkConnectionLabel(inputs.model.connection), linkSessionSettingsDetail(inputs.model),
    LinkNativeBindings.requireIcon(if (inputs.model.connection == ConnectionState.CONNECTED) "wifi" else "link"),
)

fun WearUpdatesRenderer(
    inputs: GeneratedUpdatesRenderInputs,
    emitter: GeneratedUpdatesRenderEmitter,
): List<RowSpec> = wearUpdatesRows(inputs, emitter, ZoneId.systemDefault(), Locale.getDefault())

private fun wearUpdatesRows(
    inputs: GeneratedUpdatesRenderInputs,
    emitter: GeneratedUpdatesRenderEmitter,
    zoneId: ZoneId = ZoneId.systemDefault(),
    locale: Locale = Locale.getDefault(),
): List<RowSpec> = releaseUpdateRows(
    state = inputs.model.update,
    currentVersionName = inputs.model.currentVersionName,
    onCheck = { emitter.command(LinkUpdateCommandEvent(LinkUpdateOperation.RETRY)) },
    onInstall = { emitter.command(LinkUpdateCommandEvent(LinkUpdateOperation.INSTALL)) },
    zoneId = zoneId,
    locale = locale,
)

fun WearRecoveryRenderer(
    inputs: GeneratedRecoveryRenderInputs,
    emitter: GeneratedRecoveryRenderEmitter,
): RowSpec = RowSpec(
    "recovery", "RECOVERY", inputs.model.detail.orEmpty().uppercase(),
    LinkNativeBindings.requireIcon("warning"),
)

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
