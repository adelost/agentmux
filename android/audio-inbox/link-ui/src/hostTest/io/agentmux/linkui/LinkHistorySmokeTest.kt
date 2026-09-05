package io.agentmux.linkui

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Rule
import org.junit.Test

/** One named host proof, compiled into each existing instrumentation APK.
 * Explicit local qa_state only; this test never sends or requests remote TTS. */
class LinkHistorySmokeTest {
    @get:Rule val compose = createEmptyComposeRule()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val host get() = InstrumentationRegistry.getArguments().getString("host") ?: "phone"

    @Test fun olderExchangeFullTextAndEmptyRecipient() {
        val context = instrumentation.targetContext
        val activity = if (host == "wear") "io.agentmux.audioinbox.wear.WearMainActivity"
            else "io.agentmux.audioinbox.MainActivity"
        val launch = Intent().setClassName(context, activity)
            .putExtra("qa_state", "active").putExtra("qa_case", "history")
            .putExtra("qa_host", if (host == "round") "WATCH_EXACT" else "RESPONSIVE")
            .putExtra("qa_watch_diameter", "192")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<androidx.activity.ComponentActivity>(launch).use {
            if (host != "phone") {
                row("HISTORY").performScrollTo().performClick()
                compose.onNodeWithContentDescription("Back").assertIsDisplayed()
                row("Show the earlier plan").performScrollTo()
                compose.onAllNodes(hasScrollAction()).onFirst()
                    .performSemanticsAction(SemanticsActions.ScrollBy) { scroll -> scroll(0f, 80f) }
                shot("history")
                row("Show the earlier plan").performClick()
                compose.onNodeWithContentDescription("Back").assertIsDisplayed()
                compose.onNodeWithText("Show the earlier plan").assertExists()
                row("PLAY").assertExists()
                compose.onAllNodes(hasScrollAction()).onFirst()
                    .performSemanticsAction(SemanticsActions.ScrollBy) { scroll -> scroll(0f, 10_000f) }
                shot("full-reply-end")
                compose.onNodeWithText("End of the earlier reply.", substring = true).assertExists()
                compose.onNodeWithContentDescription("Back").performClick()
                row("Voice message").performScrollTo().performClick()
                compose.onNodeWithText("Voice message").assertExists()
                row("PLAY").assertDoesNotExist()
                compose.onNodeWithContentDescription("Back").performClick()
                compose.onNodeWithContentDescription("Back").performClick()
            } else {
                compose.onAllNodes(hasScrollToIndexAction()).onFirst().performScrollToIndex(0)
                compose.onNodeWithText("Show the earlier plan").assertExists()
                shot("conversation")
            }
            if (host == "phone") row("TO demo:1").performClick()
            else row("TO demo:1").performScrollTo().performClick()
            row("demo:2").performClick()
            if (host != "phone") {
                row("HISTORY").performScrollTo().performClick()
                compose.onNodeWithText("NO MESSAGES YET").assertExists()
                compose.onNodeWithContentDescription("Back").assertIsDisplayed()
            } else compose.onNodeWithText("No messages yet").assertExists()
            shot("empty-recipient")
            compose.onAllNodesWithText("Show the earlier plan").assertCountEquals(0)
        }
    }

    private fun row(label: String) = compose.onNode(hasContentDescription(label, substring = true))

    private fun shot(name: String) {
        compose.waitForIdle()
        Thread.sleep(300) // Present the already asserted frame to SurfaceFlinger.
        val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(instrumentation.targetContext.getExternalFilesDir(null), "history-$host-$name.png")
            .outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
