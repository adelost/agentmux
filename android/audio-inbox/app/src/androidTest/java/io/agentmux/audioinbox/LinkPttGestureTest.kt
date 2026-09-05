package io.agentmux.audioinbox

import android.content.Intent
import android.graphics.Bitmap
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.adelost.designkit.ui.CircleHostMode
import com.adelost.designkit.ui.CircleHostPreviewState
import com.adelost.designkit.ui.CircleHostSurface
import com.adelost.releasekit.UpdateState
import io.agentmux.linkcore.*
import io.agentmux.linkui.*
import io.agentmux.linkui.product.*
import io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real pointer + MediaRecorder + product event graph; the only delivery sink
 * is a local list. No transport or recipient outside this test is reachable. */
class LinkPttGestureTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val round get() = InstrumentationRegistry.getArguments().getString("host") == "round"

    @Test fun sameFingerReleaseSubmitsOnceAcrossRecordingRecomposition() = withCapture { fixture ->
        val before = compose.onNodeWithContentDescription("HOLD TO TALK").fetchSemanticsNode().boundsInRoot
        compose.onRoot().performTouchInput { down(before.center) }
        compose.waitUntil(3000) { fixture.state.value.capture == CapturePhase.LISTENING }
        Thread.sleep(800) // real microphone time, not the Compose animation clock
        compose.waitForIdle()
        assertEquals(1, fixture.begins)
        assertEquals(0, fixture.releases)
        assertTrue(fixture.delivered.isEmpty())
        val active = compose.onNodeWithContentDescription("RELEASE TO SEND").fetchSemanticsNode().boundsInRoot
        assertEquals("The pressed control must not move under the finger", before.center.y, active.center.y, 1f)
        shot("recording")
        // The root keeps the original pointer: no new DOWN or re-aim at the moved label.
        compose.onRoot().performTouchInput { up() }
        compose.waitUntil(3000) { fixture.delivered.size == 1 }
        compose.waitForIdle()
        assertEquals(CapturePhase.IDLE, fixture.state.value.capture)
        assertEquals(1, fixture.begins)
        assertEquals(1, fixture.releases)
        assertEquals(0, fixture.cancels)
        assertTrue("Actual encoded microphone payload", fixture.payloadBytes > 0)
        assertEquals(0L, fixture.recorder.currentBytes())
        assertNull("No latched recorder remains after UP", fixture.recorder.release())
        shot("released")
    }

    @Test fun cancellationAndEarlyReleaseNeverSend() = withCapture { fixture ->
        val node = compose.onNodeWithContentDescription("HOLD TO TALK")
        val anchor = node.fetchSemanticsNode().boundsInRoot.center
        compose.onRoot().performTouchInput { down(anchor); advanceEventTime(40); up() }
        compose.waitForIdle()
        assertEquals(0, fixture.begins)
        compose.onRoot().performTouchInput { down(anchor) }
        compose.waitUntil(3000) { fixture.state.value.capture == CapturePhase.LISTENING }
        Thread.sleep(400)
        compose.onRoot().performTouchInput { cancel() }
        compose.waitUntil(3000) { fixture.state.value.capture == CapturePhase.IDLE }
        assertEquals(1, fixture.begins)
        assertEquals(1, fixture.cancels)
        assertEquals(0, fixture.releases)
        assertTrue(fixture.delivered.isEmpty())
        assertNull(fixture.recorder.release())
    }

    @Test fun unmountingHeldControlCancelsWithoutSending() = withCapture { fixture ->
        val anchor = compose.onNodeWithContentDescription("HOLD TO TALK").fetchSemanticsNode().boundsInRoot.center
        compose.onRoot().performTouchInput { down(anchor) }
        compose.waitUntil(3000) { fixture.state.value.capture == CapturePhase.LISTENING }
        compose.runOnUiThread { fixture.mounted = false }
        compose.waitUntil(3000) { fixture.state.value.capture == CapturePhase.IDLE }
        compose.onRoot().performTouchInput { up() }
        assertEquals(1, fixture.cancels)
        assertEquals(0, fixture.releases)
        assertTrue(fixture.delivered.isEmpty())
        assertNull(fixture.recorder.release())
    }

    private fun withCapture(check: (CaptureFixture) -> Unit) {
        val launch = Intent(instrumentation.targetContext, MainActivity::class.java)
            .putExtra("qa_state", "active")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<MainActivity>(launch).use { scenario ->
            lateinit var fixture: CaptureFixture
            scenario.onActivity { activity ->
                fixture = CaptureFixture(activity, round)
                activity.setContent {
                    CircleHostSurface(
                        isWatchDevice = round,
                        state = CircleHostPreviewState(mode = if (round) CircleHostMode.WATCH_EXACT else CircleHostMode.RESPONSIVE),
                        onStateChange = null,
                    ) {
                        LinkInteractionHost {
                            if (fixture.mounted) {
                            if (round) LinkWatchScreen(fixture.graph, "PTT LOCAL TEST", {},
                                fixture.recorder::currentBytes, fixture.recorder::currentLevel)
                            else Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                                val spec by fixture.graph.captureSpec.collectAsState()
                                LinkCaptureControl(spec, fixture.recorder::currentBytes, fixture.recorder::currentLevel,
                                    fixture.graph::beginCapture, fixture.graph::releaseCapture, fixture.graph::cancelCapture)
                            }
                            }
                        }
                    }
                }
            }
            try {
                if (round) compose.onNode(hasContentDescription("VOICE MESSAGE", substring = true))
                    .performScrollTo().performClick()
                compose.onNodeWithContentDescription("HOLD TO TALK").assertExists()
                check(fixture)
            } finally {
                scenario.onActivity { fixture.recorder.cancel(); fixture.graph.close() }
            }
        }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        Thread.sleep(250) // submit the inspected Compose frame to SurfaceFlinger
        val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(instrumentation.targetContext.getExternalFilesDir(null), "ptt-${if (round) "round" else "phone"}-$name.png")
            .outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}

private class CaptureFixture(activity: MainActivity, round: Boolean) {
    var mounted by mutableStateOf(true)
    val recorder = PushToTalkRecorder(activity)
    val state = MutableStateFlow(LinkState(targets = listOf(LinkTarget("local:ptt", "LOCAL TEST ONLY")),
        selectedTargetId = "local:ptt", connection = ConnectionState.CONNECTED))
    var begins = 0
    var releases = 0
    var cancels = 0
    var payloadBytes = 0L
    val delivered = mutableListOf<LinkCapturedTurn>()
    private val captured = MutableSharedFlow<LinkCapturedTurn>(extraBufferCapacity = 1)
    val graph = LinkProductGraph(
        processScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate), state = state,
        updateState = MutableStateFlow(UpdateState.UpToDate("test", publishedAtEpochMillis = null)),
        microphoneGranted = MutableStateFlow(true), speakReplies = MutableStateFlow(false),
        publicLinkActive = { false }, targetKindOf = { null },
        captureByteCount = recorder::currentBytes, captureByteLimit = { null }, capturedTurns = captured,
        navigation = LinkNavigationController(if (round) GeneratedLinkArtifactRef.WEAR_FULL_UI else GeneratedLinkArtifactRef.PHONE_FULL_UI),
        sinks = LinkProductSinks(captureCommand = { event ->
            when (event.operation) {
                CaptureOperation.BEGIN -> {
                    begins++
                    val audio = checkNotNull(recorder.begin())
                    state.update { it.copy(capture = CapturePhase.LISTENING, captureStartedAtMs = audio.startedAtMs) }
                }
                CaptureOperation.RELEASE -> {
                    releases++
                    val audio = checkNotNull(recorder.release())
                    payloadBytes = audio.file.length()
                    state.update { it.copy(capture = CapturePhase.FINALIZING) }
                    captured.tryEmit(LinkCapturedTurn(audio.turnId, "local:ptt", audio.file.absolutePath,
                        audio.turnId, audio.startedAtMs))
                    audio.file.delete()
                }
                CaptureOperation.CANCEL -> {
                    cancels++
                    recorder.cancel()
                    state.update { it.copy(capture = CapturePhase.IDLE) }
                }
            }
        }, capturedTurn = { turn ->
            delivered += turn
            state.update { it.copy(capture = CapturePhase.IDLE) }
        }, compose = {}, playbackCommand = {}, targetSelect = {}, preferenceToggle = {}, updateCommand = {}),
    )
}
