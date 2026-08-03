package io.agentmux.audioinbox

import io.agentmux.audioinbox.update.LinkUpdater

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.adelost.designkit.ui.RingIcons
import com.adelost.designkit.ui.CircleChoiceRole
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.releasekit.UpdateState
import com.adelost.releasekit.ui.releaseUpdateRows
import com.adelost.releasekit.updateTargetChangelog
import com.adelost.ringkit.ui.PhoneScreenHeader
import com.adelost.ringkit.ui.RingChoiceRow
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkHistoryPolicy
import io.agentmux.linkcore.LinkState
import io.agentmux.linkui.product.LinkNativeComponentRenderer
import io.agentmux.linkui.product.LinkProductSession
import io.agentmux.linkui.product.generated.LinkRoute

/**
 * Secondary behavior and connection controls stay off the conversation
 * surface. Every row remains a shared CircleKit atom; this file is wiring.
 */
@Composable
internal fun LinkPhoneSettings(
    product: LinkProductSession,
    state: LinkState,
    updateState: UpdateState,
    currentVersionName: String,
    speakReplies: Boolean,
    publicLoggedIn: Boolean,
    onBack: () -> Unit,
    onHandsFree: (Boolean) -> Unit,
    onSpeakReplies: (Boolean) -> Unit,
    onPublicLink: () -> Unit,
    onOpenDevHost: () -> Unit,
    updater: LinkUpdater,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
) {
    val route = product.route(LinkRoute.SETTINGS)
    val components = product.components(
        LinkRoute.SETTINGS,
        LocalCircleSurfaceLayout.current.surfaceClass,
    )
    val updateRows = releaseUpdateRows(
        state = updateState,
        currentVersionName = currentVersionName,
        onCheck = updater::retry,
        onInstall = updater::install,
    )
    val updateChangelog = updateTargetChangelog(updateState)
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 28.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        item("header") {
            PhoneScreenHeader(
                title = route.title,
                onBack = onBack,
                icon = product.icon(route.iconId),
            )
        }
        components.forEach { component ->
            when (component.renderer) {
                LinkNativeComponentRenderer.ACTIVE_PLAYBACK -> state.activePlaybackTurnId
                    ?.let { id -> state.turns.firstOrNull { it.turnId == id } }
                    ?.let { active ->
                        item(component.componentId) {
                            LinkPlaybackControls(
                                turn = active,
                                onPlay = {},
                                onPause = onPause,
                                onResume = onResume,
                                onStop = onStop,
                            )
                        }
                    }
                LinkNativeComponentRenderer.CONNECTION -> item(component.componentId) {
                    PhoneRow(
                        title = connectionRouteLabel(state.connectionDetail),
                        sub = state.connectionDetail.uppercase().ifBlank { "NO CONNECTION" },
                        icon = if (state.connection == ConnectionState.CONNECTED) RingIcons.Wifi else RingIcons.Link,
                    )
                }
                LinkNativeComponentRenderer.PUBLIC_LINK -> item(component.componentId) {
                    PhoneRow(
                        title = if (publicLoggedIn) "DISCONNECT PUBLIC LINK" else "CONNECT PUBLIC LINK",
                        sub = if (publicLoggedIn) "OPTIONAL FALLBACK · CONNECTED" else "OPTIONAL OUTSIDE TAILSCALE",
                        icon = product.icon(component),
                        onTap = onPublicLink,
                    )
                }
                LinkNativeComponentRenderer.PREFERENCES -> {
                    item("${component.componentId}.hands-free") {
                        RingChoiceRow(
                            title = "HANDS-FREE",
                            selected = if (state.handsFree) "ON" else "OFF",
                            options = listOf("OFF", "ON"),
                            role = CircleChoiceRole.TOGGLE,
                            onSelect = { onHandsFree(it == "ON") },
                            icon = product.icon(component),
                            modifier = phoneRowModifier(),
                        )
                    }
                    item("${component.componentId}.read-replies") {
                        RingChoiceRow(
                            title = "READ REPLIES",
                            selected = if (speakReplies) "ON" else "OFF",
                            options = listOf("OFF", "ON"),
                            role = CircleChoiceRole.TOGGLE,
                            onSelect = { onSpeakReplies(it == "ON") },
                            icon = product.icon(component),
                            modifier = phoneRowModifier(),
                        )
                    }
                }
                LinkNativeComponentRenderer.LOCAL_HISTORY -> item(component.componentId) {
                    PhoneRow(
                        title = "LOCAL HISTORY",
                        sub = "${state.turns.size} / ${LinkHistoryPolicy.MAX_LOCAL_TURNS} TURNS · OLDEST DROPS FIRST",
                        icon = product.icon(component),
                    )
                }
                LinkNativeComponentRenderer.UPDATES -> {
                    updateRows.forEach { row -> item(row.key) { PhoneRow(row) } }
                    if (updateChangelog.isNotBlank()) {
                        item("update-changelog") {
                            PhoneRow("WHAT'S NEW", updateChangelog.uppercase(), product.icon(component))
                        }
                    }
                }
                LinkNativeComponentRenderer.DEV_HOST -> item(component.componentId) {
                    PhoneRow(
                        title = "DEV HOST",
                        sub = "RESPONSIVE · WATCH EXACT",
                        icon = product.icon(component),
                        onTap = onOpenDevHost,
                    )
                }
                LinkNativeComponentRenderer.RECOVERY -> if (state.recoveryError.isNotBlank()) {
                    item(component.componentId) {
                        PhoneRow("RECOVERY", state.recoveryError.uppercase(), product.icon(component))
                    }
                }
                else -> error("${component.renderer.id} is not a Link settings component on Phone")
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
