package io.agentmux.audioinbox.wear

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.ui.RenderRingScreen
import com.adelost.ringkit.ui.RingNavigator
import com.adelost.ringkit.ui.RingScreen
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.PlaybackPhase
import kotlinx.coroutines.flow.MutableStateFlow

@Composable
internal fun WearLinkScreen(
    state: LinkState,
    onSelectTarget: (String) -> Unit,
    onHoldToTalk: () -> Unit,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
) {
    val items = remember { MutableStateFlow(emptyList<RowSpec>()) }
    val navigator = remember {
        RingNavigator(
            RingScreen.Rows(
                title = "AGENTMUX LINK",
                items = items,
                showBack = false,
            ),
        )
    }
    LaunchedEffect(state, onSelectTarget, onHoldToTalk, onPlay, onStop, onReplay) {
        items.value = wearLinkRows(
            state = state,
            onSelectTarget = onSelectTarget,
            onHoldToTalk = onHoldToTalk,
            onPlay = onPlay,
            onStop = onStop,
            onReplay = onReplay,
        )
    }
    RenderRingScreen(nav = navigator, onExit = {})
}

internal fun wearLinkRows(
    state: LinkState,
    onSelectTarget: (String) -> Unit,
    onHoldToTalk: () -> Unit,
    onPlay: () -> Unit,
    onStop: () -> Unit,
    onReplay: () -> Unit,
): List<RowSpec> {
    val selected = state.targets.firstOrNull { it.id == state.selectedTargetId }
        ?: state.targets.firstOrNull()
    val availableTargets = state.targets.filter { it.available }
    val targetChoices = availableTargets.map { it.label.ifBlank { it.id } }
    val latest = state.turns.lastOrNull()
    val selectedAvailable = selected?.available == true
    val rows = mutableListOf(
        RowSpec(
            key = "connection",
            title = connectionLabel(state.connection),
            sub = connectionSub(state),
            icon = if (state.connection == ConnectionState.CONNECTED) RingIcons.Wifi else RingIcons.Link,
        ),
        RowSpec(
            key = "target",
            title = "AGENT",
            sub = selected?.label?.ifBlank { selected.id }?.uppercase() ?: "NO TARGET",
            icon = RingIcons.Target,
            choices = targetChoices,
            onSelect = if (targetChoices.isEmpty()) {
                null
            } else {
                { label ->
                    availableTargets.firstOrNull {
                        it.label.ifBlank { it.id } == label
                    }?.let { onSelectTarget(it.id) }
                }
            },
        ),
        RowSpec(
            key = "talk",
            title = "HOLD TO TALK",
            sub = if (selectedAvailable) "RELEASE TO SEND" else "TARGET UNAVAILABLE",
            icon = RingIcons.Record,
            onTap = onHoldToTalk.takeIf { selectedAvailable },
            holdToConfirm = selectedAvailable,
        ),
    )
    if (latest == null) {
        rows += RowSpec(
            key = "latest",
            title = "LATEST REPLY",
            sub = "NO CONVERSATION YET",
            icon = RingIcons.Speaker,
        )
        return rows
    }
    rows += RowSpec(
        key = "latest",
        title = latest.respondingTarget.ifBlank { latest.targetId }.uppercase(),
        sub = latest.replyText.ifBlank { "WAITING FOR REPLY" }.uppercase().take(54),
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
    return rows
}

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.CONNECTED -> "CONNECTED"
    ConnectionState.CONNECTING -> "CONNECTING"
    ConnectionState.DISCONNECTED -> "DISCONNECTED"
    ConnectionState.CONFIGURATION_REQUIRED -> "PAIRING"
    ConnectionState.OFF -> "OFF"
}

private fun connectionSub(state: LinkState): String = when (state.connection) {
    ConnectionState.CONNECTED -> state.connectionDetail.uppercase().take(28).ifBlank { "READY" }
    ConnectionState.CONNECTING -> "LOOKING FOR LINK"
    ConnectionState.DISCONNECTED -> "OPEN PHONE TO CONNECT"
    ConnectionState.CONFIGURATION_REQUIRED -> "OPEN PHONE TO PAIR"
    ConnectionState.OFF -> "LINK IS OFF"
}
