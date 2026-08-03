package io.agentmux.audioinbox

import io.agentmux.audioinbox.update.LinkUpdater

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.adelost.designkit.ui.RingIcons
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.CircleChoiceRole
import com.adelost.designkit.ui.CircleIconDisc
import com.adelost.designkit.ui.CircleSurfaceClass
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.designkit.ui.phoneSurfaceDesign
import com.adelost.ringkit.ui.CircleHostPreviewPort
import com.adelost.ringkit.ui.PhoneScreenHeader
import com.adelost.ringkit.ui.RingChoiceRow
import com.adelost.ringkit.ui.RingPlaybackControls
import com.adelost.ringkit.ui.RingPlaybackSpec
import com.adelost.ringkit.ui.RingPlaybackState
import com.adelost.ringkit.ui.RingRow
import com.adelost.ringkit.ui.RingTextComposer
import com.adelost.ringkit.ui.RingTextInputSpec
import com.adelost.ringkit.ui.RingActionCueHost
import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.linkConnectionRoute
import io.agentmux.linkui.LinkCaptureControl
import io.agentmux.linkui.LinkCaptureSpec
import io.agentmux.linkui.LinkMenuAction
import io.agentmux.linkui.LinkWatchSurface
import io.agentmux.linkui.dispatch
import io.agentmux.linkui.linkSettingsHeaderAction
import io.agentmux.linkui.resolveLinkCaptureAvailability
import java.time.Instant
import kotlin.math.sin

/**
 * Link owns state and callbacks only. CircleKit owns the host, rows, choices,
 * composer and press-lifecycle pixels on the phone exactly as it does on Wear.
 */
@Composable
internal fun LinkPhoneScreen(
    coordinator: LinkCoordinator,
    recorder: PushToTalkRecorder,
    updater: LinkUpdater,
    updateState: UpdateState,
    hostPreview: CircleHostPreviewPort,
    microphoneGranted: Boolean,
    onRequestMicrophone: () -> Unit,
) {
    val state by coordinator.state.collectAsStateWithLifecycle()
    val qaActive = BuildConfig.DEBUG &&
        ((LocalContext.current as? Activity)?.intent?.getStringExtra("qa_state") == "active")
    val qaPage = (LocalContext.current as? Activity)?.intent?.getStringExtra("qa_page")
    val qaPlayback = BuildConfig.DEBUG &&
        ((LocalContext.current as? Activity)?.intent?.getStringExtra("qa_playback") == "active")
    var qaTargetId by remember { mutableStateOf("demo:1") }
    var qaCapture by remember { mutableStateOf(CapturePhase.IDLE) }
    var qaCaptureStartedAtMs by remember { mutableLongStateOf(0L) }
    val presentedState = if (qaActive) {
        phoneActivePreviewState(qaPlayback).copy(
            selectedTargetId = qaTargetId,
            capture = qaCapture,
            captureStartedAtMs = qaCaptureStartedAtMs,
        )
    } else {
        state
    }
    val presentedUpdateState = if (qaActive && qaPage == "settings") {
        UpdateState.Available(
            versionName = "1.2.2",
            sizeBytes = 6_400_000L,
            changelog = "Shared update information across Phone and Wear.",
            publishedAtEpochMillis = Instant.parse("2026-08-02T05:33:20Z").toEpochMilli(),
        )
    } else {
        updateState
    }
    val selectedTarget = presentedState.targets.firstOrNull {
        it.id == presentedState.selectedTargetId
    } ?: presentedState.targets.firstOrNull()
    val selectedSendable = selectedTarget?.acceptsMessages == true
    var composer by remember { mutableStateOf(ComposerDraft()) }
    var speakReplies by remember { mutableStateOf(coordinator.speaksReplies()) }
    var route by rememberSaveable {
        mutableStateOf(
            when {
                BuildConfig.DEBUG && qaPage == "dev-host" -> LinkSurfaceRoute.DEV_HOST
                BuildConfig.DEBUG && qaPage == "settings" -> LinkSurfaceRoute.SETTINGS
                else -> LinkSurfaceRoute.HOME
            },
        )
    }
    LaunchedEffect(coordinator) {
        coordinator.acceptedDrafts.collect { accepted ->
            composer = composer.accepted(accepted.turnId, accepted.draft)
        }
    }
    val selectedTargetAction: (String) -> Unit = if (qaActive) {
        { qaTargetId = it }
    } else {
        coordinator::selectTarget
    }
    val recordedLevel: () -> Float = if (qaActive) {
        {
            val phase = System.currentTimeMillis() / 85.0
            (0.16 + 0.78 * kotlin.math.abs(sin(phase))).toFloat()
        }
    } else {
        recorder::currentLevel
    }
    val beginCapture: () -> Boolean = {
        if (qaActive) {
            qaCaptureStartedAtMs = System.currentTimeMillis()
            qaCapture = CapturePhase.LISTENING
            true
        } else {
            val capture = recorder.begin()
            if (capture == null) {
                coordinator.capture(CapturePhase.FAILED)
                false
            } else {
                coordinator.capture(CapturePhase.LISTENING, capture.startedAtMs)
                true
            }
        }
    }
    val releaseCapture: () -> Unit = {
        if (qaActive) {
            qaCapture = CapturePhase.IDLE
        } else {
            coordinator.capture(CapturePhase.FINALIZING)
            val capture = recorder.release()
            if (capture == null || !coordinator.submitAudio(capture)) {
                coordinator.capture(CapturePhase.FAILED)
            }
        }
    }
    val cancelCapture: () -> Unit = {
        if (qaActive) {
            qaCapture = CapturePhase.FAILED
        } else {
            recorder.cancel()
            coordinator.capture(CapturePhase.FAILED)
        }
    }
    BackHandler(route != LinkSurfaceRoute.HOME) {
        route = if (route == LinkSurfaceRoute.DEV_HOST) {
            LinkSurfaceRoute.SETTINGS
        } else {
            LinkSurfaceRoute.HOME
        }
    }
    RingActionCueHost {
        when {
            route == LinkSurfaceRoute.DEV_HOST -> LinkDevHostScreen(
                port = hostPreview,
                onBack = { route = LinkSurfaceRoute.SETTINGS },
            )
            LocalCircleSurfaceLayout.current.surfaceClass == CircleSurfaceClass.ROUND -> {
                val latestTurnId = presentedState.turns.lastOrNull()?.turnId
                LinkWatchSurface(
                    state = presentedState,
                    updateState = presentedUpdateState,
                    currentVersionName = updater.currentVersionName,
                    showingSettings = route == LinkSurfaceRoute.SETTINGS,
                    onMenuAction = { action ->
                        action.dispatch { route = LinkSurfaceRoute.SETTINGS }
                    },
                    onBack = { route = LinkSurfaceRoute.HOME },
                    microphoneGranted = microphoneGranted || qaActive,
                    onRequestMicrophone = onRequestMicrophone,
                    onSelectTarget = selectedTargetAction,
                    onBeginCapture = beginCapture,
                    onReleaseCapture = releaseCapture,
                    onCancelCapture = cancelCapture,
                    recordedBytes = recorder::currentBytes,
                    recordedLevel = recordedLevel,
                    onPlay = { latestTurnId?.let(coordinator::playReply) },
                    onStop = coordinator::stopAudio,
                    onReplay = { latestTurnId?.let(coordinator::playReply) },
                    onCheckUpdate = updater::retry,
                    onInstallUpdate = updater::install,
                    onOpenDevHost = { route = LinkSurfaceRoute.DEV_HOST },
                )
            }
            route == LinkSurfaceRoute.SETTINGS -> {
                LinkPhoneSettings(
                    state = presentedState,
                    updateState = presentedUpdateState,
                    currentVersionName = updater.currentVersionName,
                    speakReplies = speakReplies,
                    publicLoggedIn = coordinator.publicLoggedIn(),
                    onBack = { route = LinkSurfaceRoute.HOME },
                    onHandsFree = coordinator::setHandsFree,
                    onSpeakReplies = {
                        speakReplies = it
                        coordinator.setSpeakReplies(it)
                    },
                    onPublicLink = {
                        if (coordinator.publicLoggedIn()) coordinator.logoutPublic()
                        else coordinator.beginPublicLogin()
                    },
                    onOpenDevHost = { route = LinkSurfaceRoute.DEV_HOST },
                    updater = updater,
                    onPause = coordinator::pauseAudio,
                    onResume = coordinator::resumeAudio,
                    onStop = coordinator::stopAudio,
                )
            }
            else -> {
                LinkPhoneHome(
                    state = presentedState,
                    composer = composer,
                    selectedSendable = selectedSendable,
                    onMenuAction = { action ->
                        action.dispatch { route = LinkSurfaceRoute.SETTINGS }
                    },
                    onSelectTarget = selectedTargetAction,
                    onComposerChanged = { composer = composer.edited(it) },
                    onSubmitText = {
                        if (qaActive) {
                            composer = ComposerDraft()
                        } else {
                            coordinator.submitText(composer.text)?.let {
                                composer = composer.submitted(it)
                            }
                        }
                    },
                    onPlay = coordinator::playReply,
                    onPause = coordinator::pauseAudio,
                    onResume = coordinator::resumeAudio,
                    onStop = coordinator::stopAudio,
                    ptt = {
                        LinkCaptureControl(
                            spec = LinkCaptureSpec(
                                phase = presentedState.capture,
                                startedAtMs = presentedState.captureStartedAtMs,
                                availability = resolveLinkCaptureAvailability(
                                    hasTarget = selectedTarget != null,
                                    targetAcceptsMessages = selectedSendable,
                                    microphoneGranted = microphoneGranted || qaActive,
                                    finalizing = presentedState.capture == CapturePhase.FINALIZING,
                                ),
                                byteLimit = coordinator.selectedVoiceByteLimit(),
                            ),
                            recordedBytes = recorder::currentBytes,
                            recordedLevel = recordedLevel,
                            onBegin = beginCapture,
                            onRelease = releaseCapture,
                            onCancel = cancelCapture,
                            onRecover = onRequestMicrophone,
                        )
                    },
                )
            }
        }
    }
}

private enum class LinkSurfaceRoute { HOME, SETTINGS, DEV_HOST }

@Composable
private fun LinkPhoneHome(
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
        PhoneScreenHeader(
            title = "AGENTMUX LINK",
            onBack = null,
            icon = RingIcons.Link,
            actions = listOf(
                linkSettingsHeaderAction(onMenuAction),
            ),
        )
        LinkStatusRows(state = state, onSelectTarget = onSelectTarget)
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxWidth().weight(1f),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (state.turns.isEmpty()) {
                item("empty") {
                    PhoneRow("CONVERSATION", "NO MESSAGES YET", RingIcons.Speaker)
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
        RingTextComposer(
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
        ptt()
    }
}

@Composable
private fun LinkStatusRows(state: LinkState, onSelectTarget: (String) -> Unit) {
    val available = state.targets.filter { it.available }
    val selected = available.firstOrNull { it.id == state.selectedTargetId } ?: available.firstOrNull()
    val title = "AGENT · ${linkConnectionRoute(state)}"
    if (available.size >= 2 && selected != null) {
        val choices = targetChoices(available)
        val options = choices.map { it.second }
        RingChoiceRow(
            title = title,
            selected = requireNotNull(choices.firstOrNull { it.first == selected.id }).second,
            options = options,
            role = CircleChoiceRole.STEPPED,
            onSelect = { label ->
                choices.firstOrNull { it.second == label }?.let { onSelectTarget(it.first) }
            },
            icon = RingIcons.Target,
            modifier = phoneRowModifier(),
        )
    } else {
        PhoneRow(
            title = title,
            sub = selected?.label?.ifBlank { selected.id }?.uppercase()
                ?: state.connectionDetail.ifBlank { "NO TARGET" }.uppercase().take(100),
            icon = RingIcons.Target,
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
            trailing = if (showPlayer) {
                null
            } else {
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
            LinkPlaybackControls(
                turn = turn,
                onPlay = onPlay,
                onPause = onPause,
                onResume = onResume,
                onStop = onStop,
            )
        }
        attachmentUrls(turn.replyText).forEach { url ->
            PhoneRow(
                title = "OPEN ATTACHMENT",
                sub = url.uppercase(),
                icon = RingIcons.Link,
                onTap = {
                    runCatching {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                    }
                },
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
