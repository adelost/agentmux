package io.agentmux.linkui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.unit.dp
import com.adelost.designkit.ui.GraphiteTokens
import com.adelost.designkit.ui.LocalRoundChromeReservation
import com.adelost.designkit.ui.MenuDesign
import com.adelost.designkit.ui.roundSafeRectHorizontalInsetsDp
import com.adelost.ringkit.ui.*
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkui.product.LinkPlaybackCommandEvent
import io.agentmux.linkui.product.LinkProductGraph
import kotlinx.coroutines.flow.MutableStateFlow

/** Layout-only drill-down into the same live retained conversation as Phone. */
@Composable
internal fun LinkWatchConversation(graph: LinkProductGraph, initialTurnId: String?, onBack: () -> Unit) {
    val conversation by graph.latest.collectAsState()
    val target by graph.target.collectAsState()
    val playback by graph.activePlayback.collectAsState()
    val turns = linkConversationTurns(conversation.turns, target.selectedTargetId)
    var selectedId by rememberSaveable(target.selectedTargetId) { mutableStateOf(initialTurnId) }
    val back = { if (selectedId != null && initialTurnId == null) selectedId = null else onBack() }
    BackHandler(onBack = back)
    val rows = remember { MutableStateFlow(emptyList<RowSpec>()) }
    val navigator = remember { RingNavigator(RingScreen.Rows("HISTORY", rows)) }
    val positions = rememberSaveableStateHolder()
    LaunchedEffect(turns) { rows.value = linkHistoryRows(turns, onOpen = { selectedId = it }) }
    RingRoundBackHost(back) {
        val id = selectedId
        if (id == null) {
            positions.SaveableStateProvider("history") {
                RenderRingScreen(navigator, onExit = back, backLabel = "Back")
            }
        } else key(id) {
            WatchTurnReader(
                turn = turns.firstOrNull { it.turnId == id },
                activeTurn = playback.turn?.takeIf {
                    it.playbackPhase in setOf(PlaybackPhase.QUEUED, PlaybackPhase.PLAYING)
                },
                onCommand = { operation, turnId ->
                    graph.onActivePlaybackCommand(LinkPlaybackCommandEvent(operation, turnId))
                },
            )
        }
    }
}

@Composable
private fun WatchTurnReader(
    turn: LinkTurn?,
    activeTurn: LinkTurn?,
    onCommand: (io.agentmux.linkcore.PlaybackOperation, String) -> Unit,
) {
    // A stable readable rectangle, not an inset based on the centre of a long
    // off-screen paragraph. CircleKit accounts for BOTH the circle and Back.
    BoxWithConstraints(Modifier.fillMaxSize().background(GraphiteTokens.Canvas)) {
        val verticalInset = MenuDesign.roundTitleTopPadding
        val insets = roundSafeRectHorizontalInsetsDp(
            viewportWidthDp = maxWidth.value,
            viewportHeightDp = maxHeight.value,
            contentCenterYDp = maxHeight.value / 2f,
            contentHeightDp = (maxHeight - verticalInset * 2).value,
            reservedSlots = LocalRoundChromeReservation.current,
        )
        val scroll = rememberScrollState()
        Column(Modifier.fillMaxSize()
            .padding(start = insets.start.dp, end = insets.end.dp, top = verticalInset, bottom = verticalInset)
            .clipToBounds().rotaryScroll(scroll).verticalScroll(scroll)) {
            if (turn == null) {
                RingMessage(RingMessageSpec("HISTORY", "This message is no longer in recent history."))
            } else {
                if (activeTurn != null && activeTurn.turnId != turn.turnId) {
                    linkReadAloudRow(activeTurn, onCommand)?.let { row ->
                        RingRow(row.title, "${activeTurn.targetId} · ${row.sub}", row.onTap,
                            icon = row.icon, actionTiming = row.actionTiming)
                    }
                }
                linkReadAloudRow(turn, onCommand)?.let { row ->
                    RingRow(row.title, row.sub, row.onTap, icon = row.icon, actionTiming = row.actionTiming)
                }
                LinkConversationTurn(turn,
                    onPlayback = { onCommand(it, turn.turnId) }, showPlayAction = false, openLinks = false)
            }
        }
    }
}
