package io.agentmux.audioinbox

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.adelost.designkit.ui.CircleChoiceRole
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.releasekit.ui.releaseUpdateRows
import com.adelost.releasekit.updateTargetChangelog
import com.adelost.ringkit.ui.PhoneScreenHeader
import com.adelost.ringkit.ui.RingChoiceRow
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkPreferenceKey
import io.agentmux.linkcore.LinkRecoveryPhase
import io.agentmux.linkcore.LinkUpdateOperation
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkui.activeTurnId
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkPlaybackCommandEvent
import io.agentmux.linkui.product.LinkPreferenceToggleEvent
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.LinkRouteOpenEvent
import io.agentmux.linkui.product.LinkUpdateCommandEvent
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes
import io.agentmux.linkui.product.generated.GeneratedLinkSettingsComponent
import io.agentmux.linkui.product.generated.GeneratedLinkSettingsComponents
import io.agentmux.linkui.product.generated.*

/**
 * Secondary behavior and connection controls stay off the conversation
 * surface. Every row remains a shared CircleKit atom; this file is wiring.
 */
@Composable
internal fun LinkPhoneSettings(
    graph: PhoneLinkProductGraph,
    onBack: () -> Unit,
) {
    val playback by graph.activePlaybackRenderInputs.collectAsStateWithLifecycle()
    val connection by graph.connectionRenderInputs.collectAsStateWithLifecycle()
    val publicLink by graph.publicLinkRenderInputs.collectAsStateWithLifecycle()
    val preferences by graph.preferencesRenderInputs.collectAsStateWithLifecycle()
    val localHistory by graph.localHistoryRenderInputs.collectAsStateWithLifecycle()
    val updates by graph.updatesRenderInputs.collectAsStateWithLifecycle()
    val recovery by graph.recoveryRenderInputs.collectAsStateWithLifecycle()
    // Read inside the composable, not inside the LazyListScope builder: the
    // builder lambda is not a composable context, so `.current` is unreadable
    // there. The declared tree for this surface does not change while the list
    // is being built, so resolving it once here is also the honest lifetime.
    val settingsRoute = GeneratedLinkRoutes.descriptor(LinkRoute.SETTINGS)
    val settingsTree = GeneratedLinkSettingsComponents.resolve(
        LocalCircleSurfaceLayout.current.surfaceClass,
    )
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item("header") {
            PhoneScreenHeader(
                title = settingsRoute.title,
                onBack = onBack,
                icon = LinkNativeBindings.requireIcon(settingsRoute.iconId),
            )
        }
        settingsTree
            .orderedMounts.forEach { mount ->
                when (mount.component) {
                    GeneratedLinkSettingsComponent.PAGE_HOST -> Unit
                    GeneratedLinkSettingsComponent.ACTIVE_PLAYBACK -> item(mount.id) {
                        PhoneActivePlaybackRenderer(playback, graph.activePlaybackRenderEmitter)
                    }
                    GeneratedLinkSettingsComponent.CONNECTION -> item(mount.id) {
                        PhoneConnectionRenderer(connection, GeneratedConnectionRenderEmitter)
                    }
                    GeneratedLinkSettingsComponent.PUBLIC_LINK -> item(mount.id) {
                        PhonePublicLinkRenderer(publicLink, graph.publicLinkRenderEmitter)
                    }
                    GeneratedLinkSettingsComponent.PREFERENCES -> item(mount.id) {
                        PhonePreferencesRenderer(preferences, graph.preferencesRenderEmitter)
                    }
                    GeneratedLinkSettingsComponent.LOCAL_HISTORY -> item(mount.id) {
                        PhoneLocalHistoryRenderer(localHistory, GeneratedLocalHistoryRenderEmitter)
                    }
                    GeneratedLinkSettingsComponent.UPDATES -> item(mount.id) {
                        PhoneUpdatesRenderer(updates, graph.updatesRenderEmitter)
                    }
                    GeneratedLinkSettingsComponent.DEV_HOST -> item(mount.id) {
                        PhoneRow(
                            title = "DEV HOST",
                            sub = "RESPONSIVE · WATCH EXACT",
                            icon = LinkNativeBindings.requireIcon("phone"),
                            onTap = {
                                graph.onDevHostOpen(LinkRouteOpenEvent(LinkRoute.DEV_HOST))
                            },
                        )
                    }
                    GeneratedLinkSettingsComponent.RECOVERY -> if (recovery.model.phase == LinkRecoveryPhase.QUARANTINED) {
                        item(mount.id) {
                            PhoneRecoveryRenderer(recovery, GeneratedRecoveryRenderEmitter)
                        }
                    }
                }
            }
    }
}

@Composable
internal fun PhoneActivePlaybackRenderer(
    inputs: GeneratedActivePlaybackRenderInputs,
    emitter: GeneratedActivePlaybackRenderEmitter,
) {
    val active = inputs.model.turn ?: return
    LinkPlaybackControls(
        active, {},
        { emitter.command(LinkPlaybackCommandEvent(PlaybackOperation.PAUSE, active.turnId)) },
        { emitter.command(LinkPlaybackCommandEvent(PlaybackOperation.RESUME, active.turnId)) },
        { emitter.command(LinkPlaybackCommandEvent(PlaybackOperation.STOP, active.turnId)) },
    )
}

@Composable
internal fun PhoneConnectionRenderer(
    inputs: GeneratedConnectionRenderInputs,
    emitter: GeneratedConnectionRenderEmitter,
) {
    val model = inputs.model
    PhoneRow(
        connectionRouteLabel(model.connectionDetail.orEmpty()),
        model.connectionDetail.orEmpty().uppercase().ifBlank { "NO CONNECTION" },
        LinkNativeBindings.requireIcon(if (model.connection == ConnectionState.CONNECTED) "wifi" else "link"),
    )
}

@Composable
internal fun PhonePublicLinkRenderer(
    inputs: GeneratedPublicLinkRenderInputs,
    emitter: GeneratedPublicLinkRenderEmitter,
) {
    val active = inputs.model.publicLinkActive
    PhoneRow(
        if (active) "DISCONNECT PUBLIC LINK" else "CONNECT PUBLIC LINK",
        if (active) "OPTIONAL FALLBACK · CONNECTED" else "OPTIONAL OUTSIDE TAILSCALE",
        LinkNativeBindings.requireIcon("link"),
        onTap = { emitter.command(io.agentmux.linkui.product.LinkPublicLinkCommandEvent(!active)) },
    )
}

@Composable
internal fun PhonePreferencesRenderer(
    inputs: GeneratedPreferencesRenderInputs,
    emitter: GeneratedPreferencesRenderEmitter,
) {
    Column {
        listOf(
            Triple("HANDS-FREE", LinkPreferenceKey.HANDS_FREE, inputs.model.handsFree),
            Triple("READ REPLIES", LinkPreferenceKey.SPEAK_REPLIES, inputs.model.speakReplies),
        ).forEach { (title, key, selected) ->
            RingChoiceRow(
                title, if (selected) "ON" else "OFF", listOf("OFF", "ON"), CircleChoiceRole.TOGGLE,
                { emitter.toggle(LinkPreferenceToggleEvent(key, it == "ON")) },
                LinkNativeBindings.requireIcon("speaker"), modifier = phoneRowModifier(),
            )
        }
    }
}

@Composable
internal fun PhoneLocalHistoryRenderer(
    inputs: GeneratedLocalHistoryRenderInputs,
    emitter: GeneratedLocalHistoryRenderEmitter,
) = PhoneRow(
    "LOCAL HISTORY",
    "${inputs.model.retainedTurns} / ${inputs.model.maxTurns} TURNS · OLDEST DROPS FIRST",
    LinkNativeBindings.requireIcon("activity"),
)

@Composable
internal fun PhoneUpdatesRenderer(
    inputs: GeneratedUpdatesRenderInputs,
    emitter: GeneratedUpdatesRenderEmitter,
) {
    val rows = releaseUpdateRows(
        inputs.model.update, inputs.model.currentVersionName,
        { emitter.command(LinkUpdateCommandEvent(LinkUpdateOperation.RETRY)) },
        { emitter.command(LinkUpdateCommandEvent(LinkUpdateOperation.INSTALL)) },
    )
    val changelog = updateTargetChangelog(inputs.model.update)
    Column {
        rows.forEach { PhoneRow(it) }
        if (changelog.isNotBlank()) PhoneRow(
            "WHAT'S NEW", changelog.uppercase(), LinkNativeBindings.requireIcon("download"),
        )
    }
}

@Composable
internal fun PhoneRecoveryRenderer(
    inputs: GeneratedRecoveryRenderInputs,
    emitter: GeneratedRecoveryRenderEmitter,
) = PhoneRow(
    "RECOVERY", inputs.model.detail.orEmpty().uppercase(), LinkNativeBindings.requireIcon("warning"),
)

internal fun connectionRouteLabel(detail: String): String = when {
    detail.contains("public", ignoreCase = true) -> "PUBLIC LINK"
    detail.contains("tailscale", ignoreCase = true) ||
        detail.contains("private", ignoreCase = true) -> "PRIVATE LINK"
    else -> "CONNECTION"
}
