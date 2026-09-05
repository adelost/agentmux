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
import io.agentmux.linkui.product.LinkComposeEvent
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkPlaybackCommandEvent
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.LinkRouteOpenEvent
import io.agentmux.linkui.product.LinkTargetSelectEvent
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
    var choosingRecipient by remember { mutableStateOf(false) }
    if (choosingRecipient) {
        LinkRecipientPicker(
            target = target,
            onSelect = {
                graph.onTargetSelect(LinkTargetSelectEvent(it))
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
                            items(turns, key = LinkTurn::turnId) { turn ->
                                LinkConversationTurn(
                                    turn = turn,
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
                            onSubmit = { graph.onComposerCompose(LinkComposeEvent(composer.text)) },
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
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
            }
        }
    }
}
