package io.agentmux.audioinbox

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.ui.PhoneScreenHeader
import io.agentmux.linkcore.LinkPreferenceKey
import io.agentmux.linkui.product.LinkPreferenceToggleEvent
import io.agentmux.linkui.product.LinkWakePresentation
import io.agentmux.linkui.product.wakePhaseWord
import io.agentmux.wakeword.WakePhase
import com.adelost.ringkit.ui.RingMessage
import com.adelost.ringkit.ui.RingMessageSpec
import com.adelost.ringkit.ui.RingTextComposer
import com.adelost.ringkit.ui.RingTextInputSpec
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkRecoveryPhase
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.linkConnectionLabel
import io.agentmux.linkui.LinkCaptureControl
import io.agentmux.linkui.LinkConversationTurn
import io.agentmux.linkui.linkConversationTurns
import io.agentmux.linkui.LinkRecipientPicker
import io.agentmux.linkui.activeTurnId
import io.agentmux.linkui.linkRecipientRow
import io.agentmux.linkui.linkSettingsHeaderAction
import io.agentmux.linkui.product.generated.GeneratedLinkComposeTurn
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkPlaybackCommandEvent
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.LinkRouteOpenEvent
import io.agentmux.linkui.product.generated.GeneratedLinkTargetSelect
import io.agentmux.linkui.product.generated.GeneratedLinkHomeComponent
import io.agentmux.linkui.product.generated.GeneratedLinkHomeComponents
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes

@Composable
internal fun LinkPhoneHome(
    graph: PhoneLinkProductGraph,
    onRequestMicrophone: () -> Unit,
    recordedBytes: () -> Long,
    recordedLevel: () -> Float,
) {
    val target by graph.target.collectAsStateWithLifecycle()
    val connection by graph.connection.collectAsStateWithLifecycle()
    val latest by graph.latest.collectAsStateWithLifecycle()
    val playback by graph.activePlayback.collectAsStateWithLifecycle()
    val recovery by graph.recovery.collectAsStateWithLifecycle()
    val composer by graph.composerDraft.collectAsStateWithLifecycle()
    val captureSpec by graph.captureSpec.collectAsStateWithLifecycle()
    val savedReplyAudio by graph.savedReplyAudio.collectAsStateWithLifecycle()
    val wake by graph.wakeToggleModel.collectAsStateWithLifecycle()
    val preferences by graph.preferences.collectAsStateWithLifecycle()
    var choosingRecipient by remember { mutableStateOf(false) }
    if (choosingRecipient) {
        LinkRecipientPicker(
            target = target,
            onSelect = {
                graph.onTargetSelect(GeneratedLinkTargetSelect(it))
                choosingRecipient = false
            },
            onBack = { choosingRecipient = false },
        )
        return
    }
    val turns = linkConversationTurns(latest.turns, target.selectedTargetId)
    val selected = target.targets.firstOrNull { it.id == target.selectedTargetId }
    val listState = rememberLazyListState()
    LaunchedEffect(selected?.id, turns.size, turns.lastOrNull()?.replyText) {
        if (turns.isNotEmpty()) listState.animateScrollToItem(turns.lastIndex)
    }
    BoxWithConstraints(Modifier.widthIn(max = 640.dp).fillMaxSize().imePadding()) {
        val compactEditing = maxHeight < 260.dp && WindowInsets.ime.getBottom(LocalDensity.current) > 0
        Column(
            verticalArrangement = Arrangement.spacedBy(4.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.fillMaxSize(),
        ) {
            val tree = GeneratedLinkHomeComponents.resolve(LocalCircleSurfaceLayout.current.surfaceClass)
            val route = GeneratedLinkRoutes.descriptor(LinkRoute.HOME)
            if (!compactEditing) PhoneScreenHeader(
                title = route.title,
                onBack = null,
                backLabel = "Back",
                icon = LinkNativeBindings.requireIcon(route.iconAssetRef),
                actions = if (tree.orderedMounts.any {
                    it.component == GeneratedLinkHomeComponent.NAVIGATION_SETTINGS_ENTRY
                }) listOf(linkSettingsHeaderAction {
                    graph.onSettingsActionOpen(LinkRouteOpenEvent(LinkRoute.SETTINGS))
                }) else emptyList(),
            )
            LinkHomeRegions(tree) { component ->
                when (component) {
                    GeneratedLinkHomeComponent.NAVIGATION_PAGE_HOST,
                    GeneratedLinkHomeComponent.NAVIGATION_SETTINGS_ENTRY -> Unit
                    GeneratedLinkHomeComponent.TARGET_PICKER ->
                        PhoneRow(linkRecipientRow(target) { choosingRecipient = true })
                    // Mattias 2026-09-19 asked to turn the wake word on and off "enklare ... på kanske
                    // huvudsidan". One word for where it is, one tap for on or off, writing the same
                    // preference Settings writes. Not the talk ring: a press there would fight it for the
                    // microphone (decision 2026-09-14).
                    GeneratedLinkHomeComponent.WAKE_TOGGLE -> PhoneRow(
                        title = wakePhaseWord(wake.phase),
                        sub = wakeToggleDetail(wake, preferences.wakeWord),
                        icon = LinkNativeBindings.requireIcon(
                            if (wake.phase == WakePhase.BLOCKED) "warning" else "record",
                        ),
                        onTap = {
                            graph.onWakeToggle(
                                LinkPreferenceToggleEvent(LinkPreferenceKey.WAKE_WORD, !preferences.wakeWord),
                            )
                        },
                    )
                    GeneratedLinkHomeComponent.CONVERSATION_LATEST -> LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxWidth().weight(1f),
                    ) {
                        if (turns.isEmpty()) {
                            item("empty") {
                                RingMessage(
                                    RingMessageSpec(
                                        author = "",
                                        body = if (selected == null) "Choose a recipient" else "No messages yet",
                                    ),
                                    modifier = Modifier.padding(horizontal = 24.dp),
                                )
                            }
                        } else {
                            val playbackRevision = turns.map { it.playbackPhase }
                            items(turns, key = LinkTurn::turnId) { turn ->
                                LinkConversationTurn(
                                    turn = turn,
                                    // Playing or prefetching any reply can prune the oldest saved one, so every row re-reads on either change.
                                    audio = remember(turn.turnId, turn.replyText, playbackRevision, savedReplyAudio) { graph.replyAudio(turn) },
                                    modifier = Modifier.padding(horizontal = 24.dp),
                                    onPlayback = { operation ->
                                        graph.onActivePlaybackCommand(LinkPlaybackCommandEvent(operation, turn.turnId))
                                    },
                                )
                            }
                        }
                        if (connection.connection != ConnectionState.CONNECTED && selected != null) {
                            item("connection") {
                                PhoneRow(linkConnectionLabel(connection.connection),
                                    "Open Settings for connection details.", RingIcons.Wifi)
                            }
                        }
                        if (recovery.phase == LinkRecoveryPhase.QUARANTINED) {
                            item("recovery") { PhoneRow("HISTORY", recovery.detail.orEmpty(), RingIcons.Warning) }
                        }
                    }
                    GeneratedLinkHomeComponent.PLAYBACK_CONTROLS -> LinkActivePlayback(graph, playback)
                    GeneratedLinkHomeComponent.CONVERSATION_COMPOSER -> RingTextComposer(
                        spec = RingTextInputSpec(
                            value = composer.text,
                            label = "Message",
                            enabled = selected?.acceptsMessages == true,
                            maxLength = io.agentmux.linkcore.LinkHistoryPolicy.MAX_COMPOSE_CHARS,
                            onValueChange = graph::onComposerEdited,
                            onSubmit = { graph.onComposerCompose(GeneratedLinkComposeTurn(composer.text)) },
                        ),
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp),
                    )
                    GeneratedLinkHomeComponent.CAPTURE_TALK -> if (!compactEditing) LinkCaptureControl(
                        spec = captureSpec,
                        recordedBytes = recordedBytes,
                        recordedLevel = recordedLevel,
                        onBegin = graph::beginCapture,
                        onRelease = graph::releaseCapture,
                        onCancel = graph::cancelCapture,
                        onRecover = onRequestMicrophone,
                        onCancelHandsFree = graph.cancelHandsFreeQuestion,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
            }
        }
    }
}

/**
 * What the one word does not say: why it is off, why it stopped, or what to say when it is listening.
 * The blocked reason is the loop's own sentence, never a guess made here.
 */
private fun wakeToggleDetail(wake: LinkWakePresentation, enabled: Boolean): String = when {
    wake.phase == WakePhase.BLOCKED -> wake.detail.orEmpty().ifBlank { "Wake word stopped" }
    !enabled -> "Tap to listen for \"${wake.phrase.spoken}\""
    wake.phase == WakePhase.LISTENING -> "Say \"${wake.phrase.spoken}\" · tap to stop"
    else -> wake.detail.orEmpty().ifBlank { "Tap to stop" }
}
