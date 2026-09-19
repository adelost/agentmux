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
import com.adelost.designkit.ui.CircleHostMode
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
    // Granted before the Activity is launched, so Android's own dialogs never stand between the test
    // and the page: the microphone because the page opens the loop, notifications because the service
    // posts one while it listens.
    @get:Rule val permissions: GrantPermissionRule = GrantPermissionRule.grant(
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.POST_NOTIFICATIONS,
    )

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext

    @Test fun theTryPageJudgesThePhraseAndNeverStartsAQuestion() = onTheTryPage { activity ->
        shot("try-say-it-now")
        val counted = LinkWakeStatus.status.value.detections
        play("hey-jarvis-question-sv-noise.wav", activity)
        awaitVerdict("WOULD WAKE")
        shot("try-would-wake")

        // This clip wakes every step on the JVM (WakeSensitivityTest), and the page only reads that way
        // if it was handed the whole utterance: on 2026-09-19 STRICT said NO here, because dropping the
        // question the loop had started reset the detector and cut the run to two chunks.
        assertEquals("every step should wake on this clip", 3, nodes(hasText("WAKES")).size)
        assertTrue("no step should refuse it", nodes(hasText("NO")).isEmpty())

        // The whole promise of the page, from the two places a question would show: the loop counted no
        // detection while it was open, so no capture started, and the conversation owner has no turn.
        assertEquals("a detection was counted with the page open", counted, LinkWakeStatus.status.value.detections)
        assertEquals(WakePhase.LISTENING, LinkWakeStatus.status.value.phase)
        val held = LinkRuntime.acquire(context)
        try {
            assertTrue("the coordinator never saw a question", held.state.value.turns.isEmpty())
        } finally {
            LinkRuntime.release(held)
        }
    }

    @Test fun aPhraseTheRunRuleRefusesIsSaidToHaveBeenRefused() = onTheTryPage { activity ->
        val counted = LinkWakeStatus.status.value.detections
        play("hey-jarvis-question-sv-soft.wav", activity)
        awaitVerdict("NOT HEARD")
        shot("try-not-heard")
        assertEquals(counted, LinkWakeStatus.status.value.detections)
    }

    @Test fun somethingElseSaidIsNotTheSameAsThePhraseNotBeingHeard() = onTheTryPage { activity ->
        val counted = LinkWakeStatus.status.value.detections
        play("swedish-no-wake-word.wav", activity)
        awaitVerdict("HEARD SPEECH, NOT THE PHRASE")
        shot("try-heard-speech")
        assertEquals(counted, LinkWakeStatus.status.value.detections)
    }

    @Test fun theSameClipWithThePageClosedStartsAQuestion() {
        launch { activity ->
            val counted = LinkWakeStatus.status.value.detections
            play("hey-jarvis-question-sv-noise.wav", activity)
            compose.waitUntil(45_000) { LinkWakeStatus.status.value.detections == counted + 1 }
            assertEquals(WakePhase.CAPTURING, LinkWakeStatus.status.value.phase)
            shot("no-page-question-starts")
        }
    }

    /** Opens the page the way a wearer does: the settings row that shows the step in use. */
    private fun onTheTryPage(body: (ActivityScenario<MainActivity>) -> Unit) = launch { activity ->
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
        // Straight to Settings, which is where the row under test lives; the row itself is still tapped.
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            .putExtra(MainActivity.QA_PAGE_EXTRA, MainActivity.QA_PAGE_SETTINGS)
            // The QA phone keeps whatever host preview it was last left in, and this AVD was left in a
            // watch-sized one, which renders the ROUND settings tree: no wake rows on it at all. The page
            // under test is the phone's, so the test says which host it wants instead of inheriting one.
            .putExtra("qa_host", CircleHostMode.RESPONSIVE.name)
        ActivityScenario.launch<MainActivity>(intent).use { activity ->
            try {
                body(activity)
            } catch (error: Throwable) {
                shot("failed")
                File(context.filesDir, "wake-try-failure.txt")
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
        File(context.filesDir, "wake-$name.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }
}
