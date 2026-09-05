package io.agentmux.audioinbox

import androidx.compose.foundation.layout.PaddingValues
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

/**
 * Secondary behavior and connection controls stay off the conversation
 * surface. Every row remains a shared CircleKit atom; this file is wiring.
 */
@Composable
internal fun LinkPhoneSettings(
    graph: PhoneLinkProductGraph,
    currentVersionName: String,
    onBack: () -> Unit,
    onPublicLink: () -> Unit,
) {
    val playback by graph.activePlayback.collectAsStateWithLifecycle()
    val connection by graph.connection.collectAsStateWithLifecycle()
    val publicLink by graph.publicLink.collectAsStateWithLifecycle()
    val preferences by graph.preferences.collectAsStateWithLifecycle()
    val localHistory by graph.localHistory.collectAsStateWithLifecycle()
    val updates by graph.updates.collectAsStateWithLifecycle()
    val recovery by graph.recovery.collectAsStateWithLifecycle()
    val updateRows = releaseUpdateRows(
        state = updates.update,
        currentVersionName = currentVersionName,
        onCheck = { graph.onUpdatesCommand(LinkUpdateCommandEvent(LinkUpdateOperation.RETRY)) },
        onInstall = { graph.onUpdatesCommand(LinkUpdateCommandEvent(LinkUpdateOperation.INSTALL)) },
    )
    val updateChangelog = updateTargetChangelog(updates.update)
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
                backLabel = "Back",
                icon = LinkNativeBindings.requireIcon(settingsRoute.iconAssetRef),
            )
        }
        settingsTree
            .orderedMounts.forEach { mount ->
                when (mount.component) {
                    GeneratedLinkSettingsComponent.NAVIGATION_PAGE_HOST -> Unit
                    GeneratedLinkSettingsComponent.PLAYBACK_CONTROLS -> playback.activeTurnId
                        ?.let { id -> playback.turn?.takeIf { it.turnId == id } }
                        ?.let { active ->
                            item(mount.id) {
                                LinkPlaybackControls(
                                    turn = active,
                                    onPlay = {},
                                    onPause = {
                                        graph.onActivePlaybackCommand(
                                            LinkPlaybackCommandEvent(PlaybackOperation.PAUSE, active.turnId),
                                        )
                                    },
                                    onResume = {
                                        graph.onActivePlaybackCommand(
                                            LinkPlaybackCommandEvent(PlaybackOperation.RESUME, active.turnId),
                                        )
                                    },
                                    onStop = {
                                        graph.onActivePlaybackCommand(
                                            LinkPlaybackCommandEvent(PlaybackOperation.STOP, active.turnId),
                                        )
                                    },
                                )
                            }
                        }
                    GeneratedLinkSettingsComponent.SESSION_CONNECTION -> item(mount.id) {
                        PhoneRow(
                            title = connectionRouteLabel(connection.connectionDetail.orEmpty()),
                            sub = connection.connectionDetail.orEmpty()
                                    .ifBlank { "Not connected" },
                            icon = if (connection.connection == ConnectionState.CONNECTED) {
                                LinkNativeBindings.requireIcon("wifi")
                            } else {
                                LinkNativeBindings.requireIcon("link")
                            },
                        )
                    }
                    GeneratedLinkSettingsComponent.SESSION_PUBLIC_LINK -> item(mount.id) {
                        PhoneRow(
                            title = if (publicLink.publicLinkActive) {
                                "SIGN OUT"
                            } else {
                                "CONNECT ONLINE"
                            },
                            sub = if (publicLink.publicLinkActive) {
                                "Online account connected"
                            } else {
                                "Talk to your agents away from your home network"
                            },
                            icon = LinkNativeBindings.requireIcon("link"),
                            onTap = onPublicLink,
                        )
                    }
                    GeneratedLinkSettingsComponent.PREFERENCES_TOGGLES -> {
                        item("${mount.id}.hands-free") {
                            RingChoiceRow(
                                title = "INCOMING AUDIO",
                                hint = "Play audio explicitly sent to this device, even while Link is in the background.",
                                selected = if (preferences.handsFree) "ON" else "OFF",
                                options = listOf("OFF", "ON"),
                                role = CircleChoiceRole.TOGGLE,
                                onSelect = {
                                    graph.onPreferencesToggle(
                                        LinkPreferenceToggleEvent(LinkPreferenceKey.HANDS_FREE, it == "ON"),
                                    )
                                },
                                icon = LinkNativeBindings.requireIcon("speaker"),
                                modifier = phoneRowModifier(),
                            )
                        }
                        item("${mount.id}.read-replies") {
                            RingChoiceRow(
                                title = "READ REPLIES ALOUD",
                                hint = "Read new conversation replies aloud automatically. Off keeps replies silent until you press Play.",
                                selected = if (preferences.speakReplies) "ON" else "OFF",
                                options = listOf("OFF", "ON"),
                                role = CircleChoiceRole.TOGGLE,
                                onSelect = {
                                    graph.onPreferencesToggle(
                                        LinkPreferenceToggleEvent(LinkPreferenceKey.SPEAK_REPLIES, it == "ON"),
                                    )
                                },
                                icon = LinkNativeBindings.requireIcon("speaker"),
                                modifier = phoneRowModifier(),
                            )
                        }
                    }
                    GeneratedLinkSettingsComponent.HISTORY_LOCAL -> item(mount.id) {
                        PhoneRow(
                            title = "LOCAL HISTORY",
                            sub = "${localHistory.retainedTurns} messages saved on this device. Keeps the latest ${localHistory.maxTurns}.",
                            icon = LinkNativeBindings.requireIcon("activity"),
                        )
                    }
                    GeneratedLinkSettingsComponent.UPDATES_PANEL -> {
                        updateRows.forEach { row -> item(row.key) { PhoneRow(row) } }
                        if (updateChangelog.isNotBlank()) {
                            item("update-changelog") {
                                PhoneRow(
                                    "WHAT'S NEW",
                                    updateChangelog,
                                    LinkNativeBindings.requireIcon("download"),
                                )
                            }
                        }
                    }
                    GeneratedLinkSettingsComponent.NAVIGATION_DEV_HOST_ENTRY -> item(mount.id) {
                        PhoneRow(
                            title = "DISPLAY PREVIEW",
                            sub = "Phone layout or watch-size preview",
                            icon = LinkNativeBindings.requireIcon("phone"),
                            onTap = {
                                graph.onDevHostOpen(LinkRouteOpenEvent(LinkRoute.DEV_HOST))
                            },
                        )
                    }
                    GeneratedLinkSettingsComponent.RECOVERY_STATUS -> if (recovery.phase == LinkRecoveryPhase.QUARANTINED) {
                        item(mount.id) {
                            PhoneRow(
                                "RECOVERY",
                                recovery.detail.orEmpty(),
                                LinkNativeBindings.requireIcon("warning"),
                            )
                        }
                    }
                }
            }
    }
}

internal fun connectionRouteLabel(detail: String): String = when {
    detail.contains("public", ignoreCase = true) -> "PUBLIC LINK"
    detail.contains("tailscale", ignoreCase = true) ||
        detail.contains("private", ignoreCase = true) -> "PRIVATE LINK"
    else -> "CONNECTION"
}
