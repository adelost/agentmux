package io.agentmux.audioinbox

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import androidx.compose.ui.test.performTouchInput
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import io.agentmux.wakeword.WakePhase
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test

/** Real Activity, ONNX wake/VAD, service, AAC encoding and local HTTP/playback.
 * The caller supplies synthetic PCM and a localhost mock, never a real agent. */
class LinkWakeFlowNativeTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val args = InstrumentationRegistry.getArguments()
    private val context get() = instrumentation.targetContext

    @Test fun wakeCaptureAndReplyRespectTheUsersNextAction() {
        val server = args.getString("fixtureServer")
        assumeTrue("Requires the explicit local wake fixture", server != null)
        require(server!!.startsWith("http://127.0.0.1:"))
        require(context.packageName.endsWith(".takeoverqa")) { "Only the isolated QA installation may use this fixture" }
        val case = requireNotNull(args.getString("wakeCase"))
        val wav = requireNotNull(args.getString("fixtureWav"))
        // This package is created only for this proof; no existing user's settings or history are touched.
        assertTrue(context.getSharedPreferences(AppContract.PREFS, 0).edit().clear()
            .putString(AppContract.KEY_SERVER, server)
            .putString(AppContract.KEY_TARGET, "1000000000")
            .putString(AppContract.KEY_CONVERSATION_TARGET, "qa:0")
            .putBoolean(AppContract.KEY_ENABLED, false)
            .putBoolean(AppContract.KEY_SPEAK_REPLIES, false)
            .putBoolean(KEY_WAKE_WORD, false).commit())
        val intent = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<MainActivity>(intent).use { activity ->
            try {
                compose.waitUntil(20_000) {
                    compose.onAllNodes(androidx.compose.ui.test.hasContentDescription("TO qa:0")).fetchSemanticsNodes().isNotEmpty()
                }
                activity.onActivity {
                    it.startForegroundService(Intent(it, WakeWordService::class.java)
                        .setAction(WakeWordService.ACTION_START).putExtra(WakeWordService.EXTRA_QA_WAV, wav))
                }
                awaitPhase(WakePhase.CAPTURING)
                when (case) {
                    "cancel" -> {
                        compose.waitUntil(10_000) { LinkWakeStatus.status.value.hearing?.heardSpeech == true }
                        shot("cancel-before")
                        compose.onNodeWithContentDescription("LISTENING").performTouchInput {
                            down(center); advanceEventTime(80); up()
                        }
                        awaitPhase(WakePhase.LISTENING)
                        compose.onNodeWithContentDescription("HOLD TO TALK").assertExists()
                        Thread.sleep(10_000) // the cancelled PCM and its following silence pass through the real loop
                        assertEquals(0, turns(server))
                        assertEquals(WakePhase.LISTENING, LinkWakeStatus.status.value.phase)
                    }
                    "no-auto-listen" -> {
                        awaitPhase(WakePhase.SPEAKING)
                        awaitPhase(WakePhase.LISTENING)
                        val detections = LinkWakeStatus.status.value.detections
                        Thread.sleep(28_000) // scripted ordinary speech, with no second wake phrase
                        assertEquals(detections, LinkWakeStatus.status.value.detections)
                        assertEquals(1, turns(server))
                        assertEquals(WakePhase.LISTENING, LinkWakeStatus.status.value.phase)
                    }
                    "interrupt" -> {
                        awaitPhase(WakePhase.SPEAKING)
                        val detections = LinkWakeStatus.status.value.detections
                        compose.waitUntil(25_000) {
                            LinkWakeStatus.status.value.phase == WakePhase.CAPTURING &&
                                LinkWakeStatus.status.value.detections == detections + 1
                        }
                        shot("reply-interrupted")
                        compose.onNode(
                            androidx.compose.ui.test.hasText("PLAYING", substring = true) or
                                androidx.compose.ui.test.hasContentDescription("PLAYING", substring = true),
                        ).assertDoesNotExist()
                        awaitPhase(WakePhase.SPEAKING)
                        awaitPhase(WakePhase.LISTENING)
                        assertEquals(2, turns(server))
                    }
                    else -> error("Unknown wake fixture $case")
                }
                compose.onNode(
                    androidx.compose.ui.test.hasText("DISCONNECTED", substring = true) or
                        androidx.compose.ui.test.hasContentDescription("DISCONNECTED", substring = true),
                ).assertDoesNotExist()
                shot(case)
            } catch (error: Throwable) {
                shot("failed-$case")
                File(context.getExternalFilesDir(null), "wake-failure.txt").writeText(compose.onRoot().printToString())
                throw error
            } finally {
                activity.onActivity {
                    it.startService(Intent(it, WakeWordService::class.java).setAction(WakeWordService.ACTION_STOP))
                }
                compose.waitUntil(5_000) { LinkWakeStatus.status.value.phase == WakePhase.OFF }
            }
        }
    }

    private fun awaitPhase(phase: WakePhase) = compose.waitUntil(45_000) { LinkWakeStatus.status.value.phase == phase }

    private fun turns(server: String): Int {
        val connection = URL("$server/proof").openConnection() as HttpURLConnection
        connection.connectTimeout = 2000
        connection.readTimeout = 2000
        return try { JSONObject(connection.inputStream.bufferedReader().use { it.readText() }).getInt("turns") }
        finally { connection.disconnect() }
    }

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
