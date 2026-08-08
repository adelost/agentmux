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
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item("header") {
            PhoneScreenHeader(
                title = LinkRoute.SETTINGS.headerTitle,
                onBack = onBack,
                icon = LinkNativeBindings.requireIcon(LinkRoute.SETTINGS.headerIconId),
            )
        }
        GeneratedLinkSettingsComponents.resolve(LocalCircleSurfaceLayout.current.surfaceClass)
            .orderedMounts.forEach { mount ->
                when (mount.component) {
                    GeneratedLinkSettingsComponent.ACTIVE_PLAYBACK -> playback.activeTurnId
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
                    GeneratedLinkSettingsComponent.CONNECTION -> item(mount.id) {
                        PhoneRow(
                            title = connectionRouteLabel(connection.connectionDetail.orEmpty()),
                            sub = connection.connectionDetail.orEmpty().uppercase()
                                .ifBlank { "NO CONNECTION" },
                            icon = if (connection.connection == ConnectionState.CONNECTED) {
                                LinkNativeBindings.requireIcon("wifi")
                            } else {
                                LinkNativeBindings.requireIcon("link")
                            },
                        )
                    }
                    GeneratedLinkSettingsComponent.PUBLIC_LINK -> item(mount.id) {
                        PhoneRow(
                            title = if (publicLink.publicLinkActive) {
                                "DISCONNECT PUBLIC LINK"
                            } else {
                                "CONNECT PUBLIC LINK"
                            },
                            sub = if (publicLink.publicLinkActive) {
                                "OPTIONAL FALLBACK · CONNECTED"
                            } else {
                                "OPTIONAL OUTSIDE TAILSCALE"
                            },
                            icon = LinkNativeBindings.requireIcon("link"),
                            onTap = onPublicLink,
                        )
                    }
                    GeneratedLinkSettingsComponent.PREFERENCES -> {
                        item("${mount.id}.hands-free") {
                            RingChoiceRow(
                                title = "HANDS-FREE",
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
                                title = "READ REPLIES",
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
                    GeneratedLinkSettingsComponent.LOCAL_HISTORY -> item(mount.id) {
                        PhoneRow(
                            title = "LOCAL HISTORY",
                            sub = "${localHistory.retainedTurns} / ${localHistory.maxTurns} TURNS · OLDEST DROPS FIRST",
                            icon = LinkNativeBindings.requireIcon("activity"),
                        )
                    }
                    GeneratedLinkSettingsComponent.UPDATES -> {
                        updateRows.forEach { row -> item(row.key) { PhoneRow(row) } }
                        if (updateChangelog.isNotBlank()) {
                            item("update-changelog") {
                                PhoneRow(
                                    "WHAT'S NEW",
                                    updateChangelog.uppercase(),
                                    LinkNativeBindings.requireIcon("download"),
                                )
                            }
                        }
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
                    GeneratedLinkSettingsComponent.RECOVERY -> if (recovery.phase == LinkRecoveryPhase.QUARANTINED) {
                        item(mount.id) {
                            PhoneRow(
                                "RECOVERY",
                                recovery.detail.orEmpty().uppercase(),
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
