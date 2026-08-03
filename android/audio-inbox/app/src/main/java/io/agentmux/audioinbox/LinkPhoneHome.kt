package io.agentmux.audioinbox

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.CircleChoiceRole
import com.adelost.designkit.ui.CircleIconDisc
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.designkit.ui.RingIcons
import com.adelost.designkit.ui.phoneSurfaceDesign
import com.adelost.ringkit.ui.PhoneScreenHeader
import com.adelost.ringkit.ui.RingChoiceRow
import com.adelost.ringkit.ui.RingPlaybackControls
import com.adelost.ringkit.ui.RingPlaybackSpec
import com.adelost.ringkit.ui.RingPlaybackState
import com.adelost.ringkit.ui.RingRow
import com.adelost.ringkit.ui.RingTextComposer
import com.adelost.ringkit.ui.RingTextInputSpec
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.linkConnectionRoute
import io.agentmux.linkui.linkSettingsHeaderAction
import io.agentmux.linkui.product.LinkNativeComponentRenderer
import io.agentmux.linkui.product.LinkProductSession
import io.agentmux.linkui.product.generated.LinkMenuAction
import io.agentmux.linkui.product.generated.LinkRoute

@Composable
internal fun LinkPhoneHome(
    product: LinkProductSession,
    state: LinkState,
    composer: ComposerDraft,
    selectedSendable: Boolean,
    onMenuAction: (LinkMenuAction) -> Unit,
    onSelectTarget: (String) -> Unit,
    onComposerChanged: (String) -> Unit,
    onSubmitText: () -> Unit,
    onPlay: (String) -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
    ptt: @Composable () -> Unit,
) {
    val listState = rememberLazyListState()
    LaunchedEffect(state.turns.size) {
        if (state.turns.isNotEmpty()) listState.animateScrollToItem(state.turns.lastIndex)
    }
    Column(
        verticalArrangement = Arrangement.spacedBy(2.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.fillMaxSize(),
    ) {
        val routeDescriptor = product.route(LinkRoute.HOME)
        PhoneScreenHeader(
            title = routeDescriptor.title,
            onBack = null,
            icon = product.icon(routeDescriptor.iconId),
            actions = listOf(linkSettingsHeaderAction(product, onMenuAction)),
        )
        product.components(LinkRoute.HOME, LocalCircleSurfaceLayout.current.surfaceClass)
            .forEach { component ->
                when (component.renderer) {
                    LinkNativeComponentRenderer.STATUS -> LinkStatusRows(
                        state = state,
                        onSelectTarget = onSelectTarget,
                        icon = product.icon(component),
                    )
                    LinkNativeComponentRenderer.CONVERSATION_FEED -> LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxWidth().weight(1f),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        if (state.turns.isEmpty()) {
                            item("empty") {
                                PhoneRow("CONVERSATION", "NO MESSAGES YET", product.icon(component))
                            }
                        } else {
                            items(state.turns, key = LinkTurn::turnId) { turn ->
                                ConversationTurn(
                                    turn = turn,
                                    isLatest = turn.turnId == state.turns.last().turnId,
                                    isActive = turn.turnId == state.activePlaybackTurnId,
                                    onPlay = onPlay,
                                    onPause = onPause,
                                    onResume = onResume,
                                    onStop = onStop,
                                )
                            }
                        }
                    }
                    LinkNativeComponentRenderer.COMPOSER -> RingTextComposer(
                        spec = RingTextInputSpec(
                            value = composer.text,
                            label = "MESSAGE",
                            enabled = selectedSendable,
                            maxLength = 4_000,
                            onValueChange = onComposerChanged,
                            onSubmit = onSubmitText,
                        ),
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                    LinkNativeComponentRenderer.CAPTURE -> ptt()
                    else -> error("${component.renderer.id} is not a Link home component on Phone")
                }
            }
    }
}

@Composable
private fun LinkStatusRows(
    state: LinkState,
    onSelectTarget: (String) -> Unit,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
) {
    val available = state.targets.filter { it.available }
    val selected = available.firstOrNull { it.id == state.selectedTargetId } ?: available.firstOrNull()
    val title = "AGENT · ${linkConnectionRoute(state)}"
    if (available.size >= 2 && selected != null) {
        val choices = targetChoices(available)
        RingChoiceRow(
            title = title,
            selected = requireNotNull(choices.firstOrNull { it.first == selected.id }).second,
            options = choices.map { it.second },
            role = CircleChoiceRole.STEPPED,
            onSelect = { label ->
                choices.firstOrNull { it.second == label }?.let { onSelectTarget(it.first) }
            },
            icon = icon,
            modifier = phoneRowModifier(),
        )
    } else {
        PhoneRow(
            title = title,
            sub = selected?.label?.ifBlank { selected.id }?.uppercase()
                ?: state.connectionDetail.ifBlank { "NO TARGET" }.uppercase().take(100),
            icon = icon,
        )
    }
    if (state.recoveryError.isNotBlank()) {
        PhoneRow("RECOVERY", state.recoveryError.uppercase(), RingIcons.Warning)
    }
}

@Composable
private fun ConversationTurn(
    turn: LinkTurn,
    isLatest: Boolean,
    isActive: Boolean,
    onPlay: (String) -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
) {
    val context = LocalContext.current
    PhoneRow(
        title = "YOU → ${turn.targetLabel} · ${turnStatusLabel(turn)}".uppercase(),
        sub = turn.userText.ifBlank { "VOICE MESSAGE" }.uppercase().take(320),
        icon = RingIcons.Arrow,
    )
    if (turn.replyText.isNotBlank()) {
        val showPlayer = isLatest || isActive
        RingRow(
            title = "REPLY · ${turn.respondingTarget.ifBlank { turn.targetId }}".uppercase(),
            sub = turn.replyText.uppercase().take(480),
            icon = RingIcons.Speaker,
            onTap = null,
            trailing = if (showPlayer) null else {
                {
                    val design = phoneSurfaceDesign()
                    CircleIconDisc(
                        icon = RingIcons.Play,
                        contentDescription = "Play this reply",
                        actionLabel = "PLAY",
                        onTap = { onPlay(turn.turnId) },
                        diameter = design.rowIconDiameter,
                        iconSize = design.rowIconSize,
                        timing = CircleActionTiming.IMMEDIATE,
                    )
                }
            },
            modifier = phoneRowModifier(),
        )
        if (showPlayer) {
            LinkPlaybackControls(turn, onPlay, onPause, onResume, onStop)
        }
        attachmentUrls(turn.replyText).forEach { url ->
            PhoneRow(
                title = "OPEN ATTACHMENT",
                sub = url.uppercase(),
                icon = RingIcons.Link,
                onTap = { runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } },
            )
        }
    }
    listOf(turn.deliveryError, turn.replyError, turn.playbackError)
        .filter(String::isNotBlank)
        .forEach { PhoneRow("ERROR", it.uppercase(), RingIcons.Warning) }
}

@Composable
internal fun LinkPlaybackControls(
    turn: LinkTurn,
    onPlay: (String) -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
) {
    RingPlaybackControls(
        spec = RingPlaybackSpec(
            title = turn.respondingTarget.ifBlank { turn.targetId }.uppercase(),
            state = when (turn.playbackPhase) {
                PlaybackPhase.PLAYING -> RingPlaybackState.PLAYING
                PlaybackPhase.PAUSED -> RingPlaybackState.PAUSED
                PlaybackPhase.PLAYED -> RingPlaybackState.COMPLETE
                PlaybackPhase.FAILED -> RingPlaybackState.FAILED
                else -> RingPlaybackState.READY
            },
            positionMs = turn.playbackPositionMs,
            durationMs = turn.playbackDurationMs,
            onPlayPause = when (turn.playbackPhase) {
                PlaybackPhase.PLAYING -> onPause
                PlaybackPhase.PAUSED -> onResume
                else -> ({ onPlay(turn.turnId) })
            },
            onStop = onStop,
        ),
    )
}
