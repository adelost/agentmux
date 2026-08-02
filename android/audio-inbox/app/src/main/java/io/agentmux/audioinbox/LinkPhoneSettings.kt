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
import com.adelost.releasekit.UpdateState
import com.adelost.releasekit.ui.releaseUpdateRows
import com.adelost.releasekit.updateTargetChangelog
import com.adelost.ringkit.ui.PhoneScreenHeader
import com.adelost.ringkit.ui.RingChoiceRow
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkHistoryPolicy
import io.agentmux.linkcore.LinkState

/**
 * Secondary behavior and connection controls stay off the conversation
 * surface. Every row remains a shared CircleKit atom; this file is wiring.
 */
@Composable
internal fun LinkPhoneSettings(
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
                title = "LINK SETTINGS",
                onBack = onBack,
                icon = RingIcons.Gear,
            )
        }
        state.activePlaybackTurnId
            ?.let { id -> state.turns.firstOrNull { it.turnId == id } }
            ?.let { active ->
                item("active-playback") {
                    LinkPlaybackControls(
                        turn = active,
                        onPlay = {},
                        onPause = onPause,
                        onResume = onResume,
                        onStop = onStop,
                    )
                }
            }
        item("connection") {
            PhoneRow(
                title = connectionRouteLabel(state.connectionDetail),
                sub = state.connectionDetail.uppercase().ifBlank { "NO CONNECTION" },
                icon = if (state.connection == ConnectionState.CONNECTED) {
                    RingIcons.Wifi
                } else {
                    RingIcons.Link
                },
            )
        }
        item("public-link") {
            PhoneRow(
                title = if (publicLoggedIn) "DISCONNECT PUBLIC LINK" else "CONNECT PUBLIC LINK",
                sub = if (publicLoggedIn) "OPTIONAL FALLBACK · CONNECTED" else "OPTIONAL OUTSIDE TAILSCALE",
                icon = RingIcons.Link,
                onTap = onPublicLink,
            )
        }
        item("hands-free") {
            RingChoiceRow(
                title = "HANDS-FREE",
                selected = if (state.handsFree) "ON" else "OFF",
                options = listOf("OFF", "ON"),
                role = CircleChoiceRole.TOGGLE,
                onSelect = { onHandsFree(it == "ON") },
                icon = RingIcons.Speaker,
                modifier = phoneRowModifier(),
            )
        }
        item("read-replies") {
            RingChoiceRow(
                title = "READ REPLIES",
                selected = if (speakReplies) "ON" else "OFF",
                options = listOf("OFF", "ON"),
                role = CircleChoiceRole.TOGGLE,
                onSelect = { onSpeakReplies(it == "ON") },
                icon = RingIcons.Speaker,
                modifier = phoneRowModifier(),
            )
        }
        item("history-policy") {
            PhoneRow(
                title = "LOCAL HISTORY",
                sub = "${state.turns.size} / ${LinkHistoryPolicy.MAX_LOCAL_TURNS} TURNS · OLDEST DROPS FIRST",
                icon = RingIcons.Activity,
            )
        }
        item("dev-host") {
            PhoneRow(
                title = "DEV HOST",
                sub = "RESPONSIVE · WATCH EXACT",
                icon = RingIcons.Phone,
                onTap = onOpenDevHost,
            )
        }
        updateRows.forEach { row ->
            item(row.key) { PhoneRow(row) }
        }
        if (updateChangelog.isNotBlank()) {
            item("update-changelog") {
                PhoneRow("WHAT'S NEW", updateChangelog.uppercase(), RingIcons.Activity)
            }
        }
        if (state.recoveryError.isNotBlank()) {
            item("recovery") {
                PhoneRow("RECOVERY", state.recoveryError.uppercase(), RingIcons.Warning)
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
