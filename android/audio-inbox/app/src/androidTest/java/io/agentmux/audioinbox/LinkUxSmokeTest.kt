package io.agentmux.audioinbox

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Rule
import org.junit.Test

/** Named actions exercise real hosts and typed sinks. Preview data stays explicit. */
class LinkUxSmokeTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val round get() = InstrumentationRegistry.getArguments().getString("host") == "round"

    @Test fun recipientConversationAndSettings() {
        val launch = Intent(instrumentation.targetContext, MainActivity::class.java)
            .putExtra("qa_state", "active")
            .putExtra("qa_host", if (round) "WATCH_EXACT" else "RESPONSIVE")
            .putExtra("qa_watch_diameter", "216")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<MainActivity>(launch).use { scenario ->
            compose.waitUntil(10_000) {
                compose.onAllNodes(hasContentDescription("TO demo:1", substring = true))
                    .fetchSemanticsNodes().isNotEmpty()
            }
            shot("home")
            compose.onNode(hasContentDescription("TO demo:1", substring = true)).performClick()
            compose.waitForIdle()
            shot("recipients")
            compose.onNode(hasContentDescription("demo:2", substring = true)).performClick()
            compose.onNode(hasContentDescription("TO demo:2", substring = true)).assertExists()
            shot("empty-conversation")
            if (!round) {
                compose.onNode(hasSetTextAction()).performTextInput("A draft stays here while I read.")
                shot("composer")
                compose.onNodeWithContentDescription("Open Link settings").performClick()
            } else {
                compose.onNode(hasContentDescription("SETTINGS", substring = true)).performScrollTo().performClick()
            }
            compose.waitForIdle()
            shot("settings-top")
            if (!round) {
                compose.onNode(hasScrollToIndexAction()).performScrollToNode(
                    hasContentDescription("DISPLAY PREVIEW", substring = true))
                shot("settings-bottom")
                compose.onNode(hasContentDescription("DISPLAY PREVIEW", substring = true)).performClick()
                shot("display-preview")
            }
        }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        // A finite action receipt is allowed to finish before photographing
        // the destination. No network/readiness state is fabricated here.
        Thread.sleep(1800)
        val image = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        val path = File(instrumentation.targetContext.getExternalFilesDir(null),
            "ux-${if (round) "round" else "phone"}-$name.png")
        path.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }
        image.recycle()
    }
}
