package io.agentmux.audioinbox

import android.Manifest
import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.swipeUp
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import io.agentmux.wakeword.WakePhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * Row 217, point 6. The real Activity, the real ONNX wake detector and Silero VAD, the real service and
 * the real page: a committed clip that does say the phrase is played through the loop with the TRY page
 * open, and the page has to say WOULD WAKE while no question is started at all. The same clip with the
 * page closed starts one, which is what makes the first half mean something.
 *
 * The clips are the ones the JVM tests measure (`WakeSensitivityTest`): the noisy Swedish one wakes under
 * every step, the soft one is refused by every step with its peak over the phrase's threshold, and the
 * sentence without the phrase is speech that is not it. One page state each.
 */
class LinkWakeTryNativeTest {
    @get:Rule val compose = createEmptyComposeRule()
    @get:Rule val microphone: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.RECORD_AUDIO)

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Test fun theTryPageJudgesThePhraseAndNeverStartsAQuestion() = onTheTryPage { activity ->
        shot("try-say-it-now")
        play("hey-jarvis-question-sv-noise.wav", activity)
        awaitVerdict("WOULD WAKE")
        shot("try-would-wake")

        // The whole promise of the page, from the two places a question would show: the loop never
        // counted a detection, so no capture started, and the shared conversation owner has no turn.
        assertEquals(0, LinkWakeStatus.status.value.detections)
        assertEquals(WakePhase.LISTENING, LinkWakeStatus.status.value.phase)
        val held = LinkRuntime.acquire(context)
        try {
            assertTrue("the coordinator never saw a question", held.state.value.turns.isEmpty())
        } finally {
            LinkRuntime.release(held)
        }
    }

    @Test fun aPhraseTheRunRuleRefusesIsSaidToHaveBeenRefused() = onTheTryPage { activity ->
        play("hey-jarvis-question-sv-soft.wav", activity)
        awaitVerdict("NOT HEARD")
        shot("try-not-heard")
        assertEquals(0, LinkWakeStatus.status.value.detections)
    }

    @Test fun somethingElseSaidIsNotTheSameAsThePhraseNotBeingHeard() = onTheTryPage { activity ->
        play("swedish-no-wake-word.wav", activity)
        awaitVerdict("HEARD SPEECH, NOT THE PHRASE")
        shot("try-heard-speech")
        assertEquals(0, LinkWakeStatus.status.value.detections)
    }

    @Test fun theSameClipWithThePageClosedStartsAQuestion() {
        launch { activity ->
            play("hey-jarvis-question-sv-noise.wav", activity)
            compose.waitUntil(45_000) { LinkWakeStatus.status.value.detections == 1 }
            assertEquals(WakePhase.CAPTURING, LinkWakeStatus.status.value.phase)
            shot("no-page-question-starts")
        }
    }

    /** Opens the page the way a wearer does: the settings action, then the row that shows the step. */
    private fun onTheTryPage(body: (ActivityScenario<MainActivity>) -> Unit) = launch { activity ->
        tap(hasContentDescription("Open Link settings"))
        tap(hasContentDescription("SENSITIVITY", substring = true))
        compose.waitUntil(10_000) { nodes(hasText("SAY IT NOW")).isNotEmpty() }
        body(activity)
    }

    private fun launch(body: (ActivityScenario<MainActivity>) -> Unit) {
        // Nothing of an existing installation is read: this is the debug build's own preferences file.
        assertTrue(
            context.getSharedPreferences(AppContract.PREFS, 0).edit().clear()
                .putBoolean(KEY_WAKE_WORD, false).commit(),
        )
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<MainActivity>(intent).use { activity ->
            try {
                body(activity)
            } catch (error: Throwable) {
                shot("failed")
                File(context.getExternalFilesDir(null), "wake-try-failure.txt")
                    .writeText(compose.onRoot().printToString())
                throw error
            } finally {
                activity.onActivity {
                    it.startService(Intent(it, WakeWordService::class.java).setAction(WakeWordService.ACTION_STOP))
                }
                compose.waitUntil(10_000) { LinkWakeStatus.status.value.phase == WakePhase.OFF }
            }
        }
    }

    /**
     * Plays a committed clip through the real loop. The microphone the page opened is closed first, so
     * the clip is the only thing the detector is given and the page's own recorder is still attached
     * when the loop comes back.
     */
    private fun play(clip: String, activity: ActivityScenario<MainActivity>) {
        val file = File(context.cacheDir, clip)
        instrumentation.context.assets.open(clip).use { source ->
            file.outputStream().use { source.copyTo(it) }
        }
        activity.onActivity {
            it.startService(Intent(it, WakeWordService::class.java).setAction(WakeWordService.ACTION_STOP))
        }
        compose.waitUntil(10_000) { LinkWakeStatus.status.value.phase == WakePhase.OFF }
        activity.onActivity {
            it.startForegroundService(
                Intent(it, WakeWordService::class.java)
                    .setAction(WakeWordService.ACTION_START)
                    .putExtra(WakeWordService.EXTRA_QA_WAV, file.absolutePath),
            )
        }
    }

    /** The clip is seconds long and the verdict comes after the speaker has stopped, not during. */
    private fun awaitVerdict(words: String) =
        compose.waitUntil(45_000) { nodes(hasText(words)).isNotEmpty() }

    private fun tap(matcher: androidx.compose.ui.test.SemanticsMatcher) {
        repeat(8) {
            if (nodes(matcher).isNotEmpty()) {
                // A row answers a deliberate press, not a flick: the same 250 ms a finger spends on it.
                compose.onNode(matcher).performTouchInput { down(center); advanceEventTime(250); up() }
                compose.waitForIdle()
                return
            }
            compose.onRoot().performTouchInput { swipeUp() }
            compose.waitForIdle()
        }
        error("No node for $matcher on\n${compose.onRoot().printToString()}")
    }

    private fun nodes(matcher: androidx.compose.ui.test.SemanticsMatcher) =
        compose.onAllNodes(matcher).fetchSemanticsNodes()

    private fun shot(name: String) {
        compose.waitForIdle()
        Thread.sleep(300)
        val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(context.getExternalFilesDir(null), "wake-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }
}
