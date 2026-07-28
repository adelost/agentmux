package io.agentmux.audioinbox

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
import com.adelost.designkit.ui.SkyvwActionTiming
import com.adelost.designkit.ui.SkyvwChoiceRole
import com.adelost.designkit.ui.SkyvwLabelProgress
import com.adelost.designkit.ui.SkyvwResponsiveSurface
import com.adelost.designkit.ui.SkyvwIconDisc
import com.adelost.designkit.ui.phoneSurfaceDesign
import com.adelost.ringkit.ui.PhoneHeaderAction
import com.adelost.ringkit.ui.PhoneScreenHeader
import com.adelost.ringkit.ui.RingChoiceRow
import com.adelost.ringkit.ui.RingPlaybackControls
import com.adelost.ringkit.ui.RingPlaybackSpec
import com.adelost.ringkit.ui.RingPlaybackState
import com.adelost.ringkit.ui.RingRow
import com.adelost.ringkit.ui.RingTextComposer
import com.adelost.ringkit.ui.RingTextInputSpec
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.linkConnectionRoute
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
) {
    val state by coordinator.state.collectAsStateWithLifecycle()
    val qaActive = BuildConfig.DEBUG &&
        ((LocalContext.current as? Activity)?.intent?.getStringExtra("qa_state") == "active")
    val qaSettings = BuildConfig.DEBUG &&
        ((LocalContext.current as? Activity)?.intent?.getStringExtra("qa_page") == "settings")
    val qaPlayback = BuildConfig.DEBUG &&
        ((LocalContext.current as? Activity)?.intent?.getStringExtra("qa_playback") == "active")
    var qaTargetId by remember { mutableStateOf("skyvw:3") }
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
    val selectedAvailable = presentedState.targets.firstOrNull {
        it.id == presentedState.selectedTargetId
    }?.available == true
    var composer by remember { mutableStateOf(ComposerDraft()) }
    var speakReplies by remember { mutableStateOf(coordinator.speaksReplies()) }
    var showingSettings by rememberSaveable { mutableStateOf(qaSettings) }
    LaunchedEffect(coordinator) {
        coordinator.acceptedDrafts.collect { accepted ->
            composer = composer.accepted(accepted.turnId, accepted.draft)
        }
    }
    BackHandler(showingSettings) { showingSettings = false }
    SkyvwResponsiveSurface {
        if (showingSettings) {
            LinkPhoneSettings(
                state = presentedState,
                speakReplies = speakReplies,
                publicLoggedIn = coordinator.publicLoggedIn(),
                onBack = { showingSettings = false },
                onHandsFree = coordinator::setHandsFree,
                onSpeakReplies = {
                    speakReplies = it
                    coordinator.setSpeakReplies(it)
                },
                onPublicLink = {
                    if (coordinator.publicLoggedIn()) coordinator.logoutPublic()
                    else coordinator.beginPublicLogin()
                },
                updater = updater,
                onPause = coordinator::pauseAudio,
                onResume = coordinator::resumeAudio,
                onStop = coordinator::stopAudio,
            )
        } else {
            LinkPhoneHome(
                state = presentedState,
                composer = composer,
                selectedAvailable = selectedAvailable,
                onSettings = { showingSettings = true },
                onSelectTarget = if (qaActive) {
                    { qaTargetId = it }
                } else {
                    coordinator::selectTarget
                },
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
                    PttDisc(
                        phase = presentedState.capture,
                        startedAtMs = presentedState.captureStartedAtMs,
                        enabled = selectedAvailable &&
                            presentedState.capture != CapturePhase.FINALIZING,
                        byteLimit = coordinator.selectedVoiceByteLimit(),
                        recordedBytes = recorder::currentBytes,
                        recordedLevel = if (qaActive) {
                            {
                                val phase = System.currentTimeMillis() / 85.0
                                (0.16 + 0.78 * kotlin.math.abs(sin(phase))).toFloat()
                            }
                        } else {
                            recorder::currentLevel
                        },
                        onBegin = {
                            if (qaActive) {
                                qaCaptureStartedAtMs = System.currentTimeMillis()
                                qaCapture = CapturePhase.LISTENING
                                true
                            } else {
                                val capture = recorder.begin()
                                if (capture == null) {
                                    false
                                } else {
                                    coordinator.capture(CapturePhase.LISTENING, capture.startedAtMs)
                                    true
                                }
                            }
                        },
                        onRelease = {
                            if (qaActive) {
                                qaCapture = CapturePhase.IDLE
                            } else {
                                coordinator.capture(CapturePhase.FINALIZING)
                                val capture = recorder.release()
                                if (capture == null || !coordinator.submitAudio(capture)) {
                                    coordinator.capture(CapturePhase.FAILED)
                                }
                            }
                        },
                        onCancel = {
                            if (qaActive) {
                                qaCapture = CapturePhase.FAILED
                            } else {
                                recorder.cancel()
                                coordinator.capture(CapturePhase.FAILED)
                            }
                        },
                    )
                },
            )
        }
    }
}

@Composable
private fun LinkPhoneHome(
    state: LinkState,
    composer: ComposerDraft,
    selectedAvailable: Boolean,
    onSettings: () -> Unit,
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
                PhoneHeaderAction(
                    icon = RingIcons.Gear,
                    label = "SETTINGS",
                    contentDescription = "Open Link settings",
                    onTap = onSettings,
                ),
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
                    PhoneRow("CONVERSATION", "NO CONVERSATION YET", RingIcons.Speaker)
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
                enabled = selectedAvailable,
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
            role = SkyvwChoiceRole.STEPPED,
            onSelect = { label ->
                choices.firstOrNull { it.second == label }?.let { onSelectTarget(it.first) }
            },
            icon = RingIcons.Target,
            modifier = phoneRowModifier(),
        )
    } else {
        PhoneRow(
            title = title,
            sub = selected?.label?.ifBlank { selected.id }?.uppercase() ?: "NO TARGET",
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
        sub = turn.userText.uppercase().take(320),
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
                    SkyvwIconDisc(
                        icon = RingIcons.Play,
                        contentDescription = "Play this reply",
                        actionLabel = "PLAY",
                        onTap = { onPlay(turn.turnId) },
                        diameter = design.rowIconDiameter,
                        iconSize = design.rowIconSize,
                        timing = SkyvwActionTiming.IMMEDIATE,
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

@Composable
internal fun UpdateRow(state: LinkState, updater: LinkUpdater) {
    val update = state.update
    PhoneRow(
        title = "UPDATES",
        sub = update.detail.ifBlank {
            "CURRENT ${update.currentVersion.ifBlank { "UNKNOWN" }}"
        }.uppercase(),
        icon = RingIcons.Download,
        onTap = when {
            update.canInstall -> updater::install
            update.canRetry -> updater::retry
            else -> null
        },
        progress = when (update.state) {
            "downloading" -> SkyvwLabelProgress.Determinate(update.progress.coerceIn(0f, 1f))
            "checking", "installing" -> SkyvwLabelProgress.Indeterminate
            else -> null
        },
    )
    if (update.changelog.isNotBlank()) {
        PhoneRow("WHAT'S NEW", update.changelog.uppercase(), RingIcons.Activity)
    }
}

@Composable
internal fun PhoneRow(
    title: String,
    sub: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    onTap: (() -> Unit)? = null,
    immediate: Boolean = false,
    progress: SkyvwLabelProgress? = null,
) {
    RingRow(
        title = title,
        sub = sub,
        icon = icon,
        onTap = onTap,
        labelProgress = progress,
        actionTiming = if (immediate) SkyvwActionTiming.IMMEDIATE else SkyvwActionTiming.DELIBERATE,
        modifier = phoneRowModifier(),
    )
}

internal fun phoneRowModifier(): Modifier =
    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
