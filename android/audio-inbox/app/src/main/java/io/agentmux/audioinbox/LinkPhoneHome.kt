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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.vectorResource
import com.adelost.designkit.ui.CircleAccent
import com.adelost.designkit.ui.CircleAccentStrength
import com.adelost.designkit.ui.circleAccentColor
import io.agentmux.linkui.product.wakePhaseWord
import io.agentmux.wakeword.WakePhase
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
                        title = wake.phrase.spoken.uppercase(),
                        sub = wakeRowDetail(wake, captureSpec.wake.hearing?.sendsInMs),
                        // The declared phase glyph, the same three the status bar wears, so the row stops
                        // looking like the recipient row above it. BLOCKED is the row's own exception and
                        // not a regrouping: the status bar answers what Link is hearing, where a row that
                        // needs a person to do something has to say so (lsrc:0 M2, 2026-09-19).
                        icon = if (wake.phase == WakePhase.BLOCKED) {
                            LinkNativeBindings.requireIcon("warning")
                        } else {
                            ImageVector.vectorResource(wakeGlyphDrawable(wake.phase))
                        },
                        // A wake word that is off is not doing anything, and the row says so quietly.
                        semanticColor = if (wake.phase == WakePhase.OFF) {
                            circleAccentColor(CircleAccent.NEUTRAL, CircleAccentStrength.INACTIVE)
                        } else {
                            null
                        },
                        onTap = {
                            graph.onWakeToggle(
                                LinkPreferenceToggleEvent(
                                    LinkPreferenceKey.WAKE_WORD,
                                    // A blocked row is tapped to repair it. Toggling would switch off a
                                    // wake word that is already on, which is not what the row offers.
                                    if (wake.phase == WakePhase.BLOCKED) true else !preferences.wakeWord,
                                ),
                            )
                        },
                    )
                    GeneratedLinkHomeComponent.CONVERSATION_LATEST -> LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxWidth().weight(1f),
                    ) {
                        // lsrc:0 M2026-09-19 M3, one statement per fact: with no recipient the row and
                        // the talk ring both say to choose one, so a third line saying it again goes, and
                        // the conversation area stays empty until there is a conversation.
                        if (turns.isNotEmpty()) {
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
 * The declared phase word first, then the one thing that word does not say. The row is titled by the
 * phrase, so the second line never repeats it.
 *
 * lsrc:0 M1, 2026-09-19: a row titled OFF under CHOOSE RECIPIENT does not say what is off, and the phrase
 * is exactly what a wearer has to say out loud. The blocked reason is the loop's own sentence, never a
 * guess made here, so the one place that knows why it is blocked is the only place that words it.
 */
internal fun wakeRowDetail(wake: LinkWakePresentation, sendsInMs: Int?): String {
    val word = wakePhaseWord(wake.phase)
    val rest = when (wake.phase) {
        WakePhase.OFF -> "tap to listen"
        WakePhase.LISTENING -> "tap to stop"
        // The countdown the talk ring draws as a digit, in words, for the row that has no ring.
        WakePhase.CAPTURING -> sendsInMs?.let { "${(it + 999) / 1_000} s" }.orEmpty()
        else -> wake.detail.orEmpty()
    }
    return if (rest.isBlank()) word else "$word · $rest"
}
