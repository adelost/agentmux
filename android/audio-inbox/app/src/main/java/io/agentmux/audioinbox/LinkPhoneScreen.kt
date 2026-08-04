package io.agentmux.audioinbox

import io.agentmux.audioinbox.update.LinkUpdater

import android.app.Activity
import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.adelost.designkit.ui.CircleSurfaceClass
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.ringkit.ui.CircleHostPreviewPort
import com.adelost.ringkit.ui.RingActionCueHost
import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.CapturePhase
import io.agentmux.linkui.LinkCaptureControl
import io.agentmux.linkui.LinkCaptureSpec
import io.agentmux.linkui.LinkWatchSurface
import io.agentmux.linkui.dispatch
import io.agentmux.linkui.product.LinkNativeComponentRenderer
import io.agentmux.linkui.product.LinkProductRuntime
import io.agentmux.linkui.product.LinkProductSession
import io.agentmux.linkui.product.generated.LinkRoute
import io.agentmux.linkui.resolveLinkCaptureAvailability
import java.time.Instant
import kotlin.math.sin

/**
 * Link owns state and callbacks only. CircleKit owns the host, rows, choices,
 * composer and press-lifecycle pixels on the phone exactly as it does on Wear.
 */
@Composable
internal fun LinkPhoneScreen(
    product: LinkProductSession,
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
                BuildConfig.DEBUG && qaPage == "dev-host" -> LinkRoute.DEV_HOST
                BuildConfig.DEBUG && qaPage == "settings" -> LinkRoute.SETTINGS
                else -> LinkRoute.HOME
            },
        )
    }
    val runtime = remember(coordinator, recorder, updater) {
        LinkProductRuntime(
            PhoneLinkProductPorts(
                coordinator = coordinator,
                recorder = recorder,
                updater = updater,
                currentRoute = { route },
                navigate = { route = it },
            ),
        )
    }
    val navigate: (LinkRoute) -> Unit = { destination ->
        route = runtime.open(destination)
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
            runtime.beginCapture()
        }
    }
    val releaseCapture: () -> Unit = {
        if (qaActive) {
            qaCapture = CapturePhase.IDLE
        } else {
            runtime.releaseCapture()
        }
    }
    val cancelCapture: () -> Unit = {
        if (qaActive) {
            qaCapture = CapturePhase.FAILED
        } else {
            runtime.cancelCapture()
        }
    }
    BackHandler(route != LinkRoute.HOME) {
        navigate(if (route == LinkRoute.DEV_HOST) {
            LinkRoute.SETTINGS
        } else {
            LinkRoute.HOME
        })
    }
    RingActionCueHost {
        when {
            route == LinkRoute.DEV_HOST -> {
                check(
                    product.components(
                        LinkRoute.DEV_HOST,
                        LocalCircleSurfaceLayout.current.surfaceClass,
                    ).single().renderer == LinkNativeComponentRenderer.DEV_PREVIEW,
                )
                LinkDevHostScreen(
                    port = hostPreview,
                    onBack = { navigate(LinkRoute.SETTINGS) },
                )
            }
            LocalCircleSurfaceLayout.current.surfaceClass == CircleSurfaceClass.ROUND -> {
                val latestTurnId = presentedState.turns.lastOrNull()?.turnId
                LinkWatchSurface(
                    product = product,
                    state = presentedState,
                    updateState = presentedUpdateState,
                    currentVersionName = updater.currentVersionName,
                    route = route,
                    onNavigate = navigate,
                    onBack = { navigate(LinkRoute.HOME) },
                    microphoneGranted = microphoneGranted || qaActive,
                    onRequestMicrophone = onRequestMicrophone,
                    onSelectTarget = selectedTargetAction,
                    onBeginCapture = beginCapture,
                    onReleaseCapture = releaseCapture,
                    onCancelCapture = cancelCapture,
                    recordedBytes = recorder::currentBytes,
                    recordedLevel = recordedLevel,
                    onPlay = { latestTurnId?.let(runtime::play) },
                    onStop = { latestTurnId?.let(runtime::stop) },
                    onReplay = { latestTurnId?.let(runtime::play) },
                    onCheckUpdate = updater::retry,
                    onInstallUpdate = updater::install,
                    onOpenDevHost = { navigate(LinkRoute.DEV_HOST) },
                )
            }
            route == LinkRoute.SETTINGS -> {
                LinkPhoneSettings(
                    product = product,
                    state = presentedState,
                    updateState = presentedUpdateState,
                    currentVersionName = updater.currentVersionName,
                    speakReplies = speakReplies,
                    publicLoggedIn = coordinator.publicLoggedIn(),
                    onBack = { navigate(LinkRoute.HOME) },
                    onHandsFree = coordinator::setHandsFree,
                    onSpeakReplies = {
                        speakReplies = it
                        coordinator.setSpeakReplies(it)
                    },
                    onPublicLink = {
                        if (coordinator.publicLoggedIn()) coordinator.logoutPublic()
                        else coordinator.beginPublicLogin()
                    },
                    onOpenDevHost = { navigate(LinkRoute.DEV_HOST) },
                    updater = updater,
                    onPause = { presentedState.activePlaybackTurnId?.let(runtime::pause) },
                    onResume = { presentedState.activePlaybackTurnId?.let(runtime::resume) },
                    onStop = { presentedState.activePlaybackTurnId?.let(runtime::stop) },
                )
            }
            else -> {
                LinkPhoneHome(
                    product = product,
                    state = presentedState,
                    composer = composer,
                    selectedSendable = selectedSendable,
                    onMenuAction = { action ->
                        action.dispatch(product, navigate)
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
                    onPlay = runtime::play,
                    onPause = { presentedState.activePlaybackTurnId?.let(runtime::pause) },
                    onResume = { presentedState.activePlaybackTurnId?.let(runtime::resume) },
                    onStop = { presentedState.activePlaybackTurnId?.let(runtime::stop) },
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
