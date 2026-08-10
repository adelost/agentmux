package io.agentmux.audioinbox

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
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
import io.agentmux.linkcore.LinkRecoveryPhase
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackOperation
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkui.LinkCaptureControl
import io.agentmux.linkui.activeTurnId
import io.agentmux.linkui.linkSessionRoute
import io.agentmux.linkui.linkSettingsHeaderAction
import io.agentmux.linkui.product.LinkComposeEvent
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkPlaybackCommandEvent
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.LinkRouteOpenEvent
import io.agentmux.linkui.product.LinkSessionPresentation
import io.agentmux.linkui.product.LinkTargetPresentation
import io.agentmux.linkui.product.LinkTargetSelectEvent
import io.agentmux.linkui.product.generated.GeneratedLinkHomeComponent
import io.agentmux.linkui.product.generated.GeneratedLinkHomeComponents
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes

@Composable
internal fun LinkPhoneHome(
    graph: PhoneLinkProductGraph,
) {
    val target by graph.targetRenderInputs.collectAsStateWithLifecycle()
    val latest by graph.latestRenderInputs.collectAsStateWithLifecycle()
    val composer by graph.composerRenderInputs.collectAsStateWithLifecycle()
    val talk by graph.talkRenderInputs.collectAsStateWithLifecycle()
    Column(
        verticalArrangement = Arrangement.spacedBy(2.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        modifier = Modifier.fillMaxSize(),
    ) {
        val tree = GeneratedLinkHomeComponents.resolve(LocalCircleSurfaceLayout.current.surfaceClass)
        val settingsAction = tree.orderedMounts.firstOrNull {
            it.component == GeneratedLinkHomeComponent.SETTINGS_ACTION
        }
        val route = GeneratedLinkRoutes.descriptor(LinkRoute.HOME)
        PhoneScreenHeader(
            title = route.title,
            onBack = null,
            icon = LinkNativeBindings.requireIcon(route.iconId),
            actions = if (settingsAction != null) {
                listOf(
                    linkSettingsHeaderAction {
                        graph.onSettingsActionOpen(LinkRouteOpenEvent(LinkRoute.SETTINGS))
                    },
                )
            } else {
                emptyList()
            },
        )
        tree.orderedMounts.forEach { mount ->
            when (mount.component) {
                GeneratedLinkHomeComponent.PAGE_HOST -> Unit
                GeneratedLinkHomeComponent.TARGET -> PhoneTargetRenderer(target, graph.targetRenderEmitter)
                GeneratedLinkHomeComponent.LATEST -> Box(
                    Modifier.fillMaxWidth().weight(1f),
                ) { PhoneLatestRenderer(latest, graph.latestRenderEmitter) }
                GeneratedLinkHomeComponent.COMPOSER -> PhoneComposerRenderer(
                    composer, graph.composerRenderEmitter,
                )
                GeneratedLinkHomeComponent.TALK -> LinkCaptureControl(
                    inputs = talk,
                    emitter = graph.talkRenderEmitter,
                )
                GeneratedLinkHomeComponent.SETTINGS_ACTION -> Unit
            }
        }
    }
}

@Composable
internal fun PhoneTargetRenderer(
    inputs: io.agentmux.linkui.product.generated.GeneratedTargetRenderInputs,
    emitter: io.agentmux.linkui.product.generated.GeneratedTargetRenderEmitter,
) = LinkStatusRows(
    target = inputs.model,
    session = inputs.session,
    recoveryDetail = inputs.recovery.detail.takeIf {
        inputs.recovery.phase == LinkRecoveryPhase.QUARANTINED
    },
    onSelectTarget = { emitter.select(LinkTargetSelectEvent(it)) },
    icon = LinkNativeBindings.requireIcon("target"),
)

@Composable
internal fun PhoneComposerRenderer(
    inputs: io.agentmux.linkui.product.generated.GeneratedComposerRenderInputs,
    emitter: io.agentmux.linkui.product.generated.GeneratedComposerRenderEmitter,
) = RingTextComposer(
    spec = RingTextInputSpec(
        value = inputs.model.draftText,
        label = "MESSAGE",
        enabled = inputs.target.selectedTargetId != null,
        maxLength = 4_000,
        onValueChange = { emitter.edit(io.agentmux.linkui.product.LinkComposerEditEvent(it)) },
        onSubmit = { emitter.compose(LinkComposeEvent(inputs.model.draftText)) },
    ),
    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
)

@Composable
internal fun PhoneLatestRenderer(
    inputs: io.agentmux.linkui.product.generated.GeneratedLatestRenderInputs,
    emitter: io.agentmux.linkui.product.generated.GeneratedLatestRenderEmitter,
) {
    val listState = rememberLazyListState()
    LaunchedEffect(inputs.model.turns.size) {
        if (inputs.model.turns.isNotEmpty()) listState.animateScrollToItem(inputs.model.turns.lastIndex)
    }
    LazyColumn(
        state = listState,
        modifier = Modifier.fillMaxWidth(),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
    if (inputs.model.turns.isEmpty()) {
        item("empty") {
            PhoneRow("CONVERSATION", "NO MESSAGES YET", LinkNativeBindings.requireIcon("speaker"))
        }
    } else {
        items(inputs.model.turns, key = LinkTurn::turnId) { turn ->
            val activeTurnId = inputs.playback.turnId
            ConversationTurn(
                turn = turn,
                isLatest = turn.turnId == inputs.model.turns.last().turnId,
                isActive = turn.turnId == activeTurnId,
                onPlay = { emitter.playbackCommand(LinkPlaybackCommandEvent(PlaybackOperation.PLAY, it)) },
                onPause = { activeTurnId?.let { emitter.playbackCommand(LinkPlaybackCommandEvent(PlaybackOperation.PAUSE, it)) } },
                onResume = { activeTurnId?.let { emitter.playbackCommand(LinkPlaybackCommandEvent(PlaybackOperation.RESUME, it)) } },
                onStop = { activeTurnId?.let { emitter.playbackCommand(LinkPlaybackCommandEvent(PlaybackOperation.STOP, it)) } },
                onOpenAttachment = { emitter.openAttachment(io.agentmux.linkui.product.LinkOpenAttachmentEvent(it)) },
            )
        }
    }
    }
}

@Composable
private fun LinkStatusRows(
    target: LinkTargetPresentation,
    session: LinkSessionPresentation,
    recoveryDetail: String?,
    onSelectTarget: (String) -> Unit,
    icon: ImageVector,
) {
    val selected = target.targets.firstOrNull { it.id == target.selectedTargetId }
    val title = "AGENT · ${linkSessionRoute(session)}"
    if (target.targets.size >= 2 && selected != null) {
        val choices = targetChoices(target.targets)
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
                ?: session.connectionDetail.orEmpty().ifBlank { "NO TARGET" }.uppercase().take(100),
            icon = icon,
        )
    }
    if (!recoveryDetail.isNullOrBlank()) {
        PhoneRow("RECOVERY", recoveryDetail.uppercase(), RingIcons.Warning)
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
    onOpenAttachment: (String) -> Unit,
) {
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
                onTap = { onOpenAttachment(url) },
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
