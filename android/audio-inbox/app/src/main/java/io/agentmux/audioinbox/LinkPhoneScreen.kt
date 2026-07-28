package io.agentmux.audioinbox

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
import com.adelost.ringkit.ui.PhoneScreenHeader
import com.adelost.ringkit.ui.RingChoiceRow
import com.adelost.ringkit.ui.RingRow
import com.adelost.ringkit.ui.RingTextComposer
import com.adelost.ringkit.ui.RingTextInputSpec
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkcore.ConnectionState
import io.agentmux.linkcore.DeliveryPhase
import io.agentmux.linkcore.LinkState
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkcore.LinkTurn
import io.agentmux.linkcore.PlaybackPhase
import io.agentmux.linkcore.ReplyPhase
import io.agentmux.linkcore.UpdatePresentation
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
    var qaTargetId by remember { mutableStateOf("skyvw:3") }
    var qaCapture by remember { mutableStateOf(CapturePhase.IDLE) }
    var qaCaptureStartedAtMs by remember { mutableLongStateOf(0L) }
    val presentedState = if (qaActive) {
        phoneActivePreviewState().copy(
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
    LaunchedEffect(coordinator) {
        coordinator.acceptedDrafts.collect { accepted ->
            composer = composer.accepted(accepted.turnId, accepted.draft)
        }
    }
    SkyvwResponsiveSurface {
        Column(
            verticalArrangement = Arrangement.spacedBy(4.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(bottom = 28.dp),
        ) {
            PhoneScreenHeader(title = "AGENTMUX LINK", onBack = null, icon = RingIcons.Link)
            LinkStatusRows(
                state = presentedState,
                onSelectTarget = if (qaActive) {
                    { qaTargetId = it }
                } else {
                    coordinator::selectTarget
                },
            )
            ConversationRows(
                turns = presentedState.turns,
                onPlay = coordinator::playReply,
                onPause = coordinator::pauseAudio,
                onResume = coordinator::resumeAudio,
                onStop = coordinator::stopAudio,
            )
            RingTextComposer(
                spec = RingTextInputSpec(
                    value = composer.text,
                    label = "TYPE ANOTHER MESSAGE",
                    enabled = selectedAvailable,
                    maxLength = 4_000,
                    onValueChange = { composer = composer.edited(it) },
                    onSubmit = {
                        if (qaActive) {
                            composer = ComposerDraft()
                        } else {
                            coordinator.submitText(composer.text)?.let {
                                composer = composer.submitted(it)
                            }
                        }
                    },
                ),
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
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
            if (presentedState.activePlaybackTurnId != null ||
                presentedState.connectionDetail.startsWith("Playing", ignoreCase = true)
            ) {
                PhoneRow(
                    title = "STOP AUDIO",
                    sub = "PLAYBACK ACTIVE",
                    icon = RingIcons.Stop,
                    onTap = coordinator::stopAudio,
                    immediate = true,
                )
            }
            RingChoiceRow(
                title = "HANDS-FREE",
                selected = if (presentedState.handsFree) "ON" else "OFF",
                options = listOf("OFF", "ON"),
                role = SkyvwChoiceRole.TOGGLE,
                onSelect = { coordinator.setHandsFree(it == "ON") },
                icon = RingIcons.Speaker,
                modifier = phoneRowModifier(),
            )
            RingChoiceRow(
                title = "READ REPLIES",
                selected = if (speakReplies) "ON" else "OFF",
                options = listOf("OFF", "ON"),
                role = SkyvwChoiceRole.TOGGLE,
                onSelect = {
                    speakReplies = it == "ON"
                    coordinator.setSpeakReplies(speakReplies)
                },
                icon = RingIcons.Speaker,
                modifier = phoneRowModifier(),
            )
            PhoneRow(
                title = if (coordinator.publicLoggedIn()) {
                    "DISCONNECT PUBLIC LINK"
                } else {
                    "CONNECT PUBLIC LINK"
                },
                sub = "ACCOUNT",
                icon = RingIcons.Link,
                onTap = {
                    if (coordinator.publicLoggedIn()) coordinator.logoutPublic()
                    else coordinator.beginPublicLogin()
                },
            )
            UpdateRow(presentedState, updater)
            Spacer(Modifier.height(20.dp))
        }
    }
}

@Composable
private fun LinkStatusRows(state: LinkState, onSelectTarget: (String) -> Unit) {
    PhoneRow(
        title = connectionLabel(state.connection),
        sub = state.connectionDetail.uppercase().ifBlank { "NO STATUS" },
        icon = if (state.connection == ConnectionState.CONNECTED) RingIcons.Wifi else RingIcons.Link,
    )
    val available = state.targets.filter { it.available }
    val selected = available.firstOrNull { it.id == state.selectedTargetId } ?: available.firstOrNull()
    if (available.size >= 2 && selected != null) {
        val choices = targetChoices(available)
        val options = choices.map { it.second }
        RingChoiceRow(
            title = "AGENT",
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
            title = "AGENT",
            sub = selected?.label?.ifBlank { selected.id }?.uppercase() ?: "NO TARGET",
            icon = RingIcons.Target,
        )
    }
    if (state.recoveryError.isNotBlank()) {
        PhoneRow("RECOVERY", state.recoveryError.uppercase(), RingIcons.Warning)
    }
}

@Composable
private fun ConversationRows(
    turns: List<LinkTurn>,
    onPlay: (String) -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
) {
    val context = LocalContext.current
    if (turns.isEmpty()) {
        PhoneRow("CONVERSATION", "NO CONVERSATION YET", RingIcons.Speaker)
        return
    }
    turns.takeLast(30).forEach { turn ->
        PhoneRow(
            title = "YOU → ${turn.targetLabel} · ${turnStatusLabel(turn)}".uppercase(),
            sub = turn.userText.uppercase().take(160),
            icon = RingIcons.Arrow,
        )
        if (turn.replyText.isNotBlank()) {
            val action: (() -> Unit)? = when (turn.playbackPhase) {
                PlaybackPhase.PLAYING -> onPause
                PlaybackPhase.PAUSED -> onResume
                else -> ({ onPlay(turn.turnId) })
            }
            PhoneRow(
                title = "REPLY · ${turn.respondingTarget.ifBlank { turn.targetId }}".uppercase(),
                sub = turn.replyText.uppercase().take(220),
                icon = when (turn.playbackPhase) {
                    PlaybackPhase.PLAYING -> RingIcons.Pause
                    else -> RingIcons.Play
                },
                onTap = action,
                immediate = true,
            )
            if (turn.playbackPhase == PlaybackPhase.PLAYING ||
                turn.playbackPhase == PlaybackPhase.PAUSED
            ) {
                PhoneRow("STOP REPLY", "PLAYBACK", RingIcons.Stop, onStop, immediate = true)
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
}

@Composable
private fun UpdateRow(state: LinkState, updater: LinkUpdater) {
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
private fun PhoneRow(
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

private fun phoneRowModifier(): Modifier =
    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)

private fun connectionLabel(state: ConnectionState): String = when (state) {
    ConnectionState.CONNECTED -> "CONNECTED"
    ConnectionState.CONNECTING -> "CONNECTING"
    ConnectionState.DISCONNECTED -> "DISCONNECTED"
    ConnectionState.CONFIGURATION_REQUIRED -> "PAIRING"
    ConnectionState.OFF -> "OFF"
}

internal fun targetChoices(targets: List<LinkTarget>): List<Pair<String, String>> {
    val baseLabels = targets.associateWith { it.label.ifBlank { it.id }.uppercase() }
    val duplicates = baseLabels.values.groupingBy { it }.eachCount()
    return targets.map { target ->
        val base = requireNotNull(baseLabels[target])
        target.id to if (duplicates.getValue(base) > 1) {
            "$base · ${target.id.uppercase()}"
        } else {
            base
        }
    }
}

private fun attachmentUrls(text: String): List<String> =
    Regex("""https?://[^\s<>()\]"]+""")
        .findAll(text)
        .map { it.value.trimEnd('.', ',', ';') }
        .distinct()
        .take(4)
        .toList()

private fun turnStatusLabel(turn: LinkTurn): String = when {
    turn.playbackPhase == PlaybackPhase.PLAYING -> "PLAYING"
    turn.playbackPhase == PlaybackPhase.PAUSED -> "PAUSED"
    turn.deliveryPhase == DeliveryPhase.FAILED -> "SEND FAILED"
    turn.replyPhase == ReplyPhase.FAILED -> "REPLY FAILED"
    turn.replyPhase == ReplyPhase.READY -> "REPLY READY"
    turn.replyPhase == ReplyPhase.THINKING -> "THINKING"
    turn.deliveryPhase == DeliveryPhase.QUEUED -> "SENT"
    else -> "SENDING"
}

private fun phoneActivePreviewState(): LinkState = LinkState(
    connection = ConnectionState.CONNECTED,
    connectionDetail = "PRIVATE RELAY READY",
    connectionObservedAtMs = System.currentTimeMillis(),
    targets = listOf(
        LinkTarget(id = "skyvw:3", label = "SKYVW 3"),
        LinkTarget(id = "skyvw:9", label = "SKYVW 9"),
    ),
    selectedTargetId = "skyvw:3",
    turns = listOf(
        LinkTurn(
            turnId = "qa-turn",
            targetId = "skyvw:3",
            targetLabel = "SKYVW 3",
            userText = "Use the shared CircleKit components.",
            replyText = "The phone and watch now speak the same visual language.",
            respondingTarget = "SKYVW 3",
            createdAtMs = System.currentTimeMillis() - 12_000,
            deliveryPhase = DeliveryPhase.QUEUED,
            replyPhase = ReplyPhase.READY,
            playbackPhase = PlaybackPhase.STOPPED,
        ),
    ),
    update = UpdatePresentation(
        currentVersion = "1.0.0",
        state = "up-to-date",
        detail = "UP TO DATE",
    ),
)
