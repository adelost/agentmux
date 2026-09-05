package io.agentmux.audioinbox.wear

import android.content.Intent
import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/** Real Wear Activity/graph/recorder, explicit demo catalog and no mailbox
 * session. Normal UP must end capture even though delivery is unavailable.
 * The shared LinkPttGestureTest separately counts local delivery exactly once. */
class WearPttGestureTest {
    @get:Rule val compose = createEmptyComposeRule()

    @Test fun releaseEndsRecordingAndCancelDiscardsOnNativeWear() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val launch = Intent(context, WearMainActivity::class.java)
            .putExtra("qa_state", "active")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        ActivityScenario.launch<WearMainActivity>(launch).use {
            compose.onNode(hasContentDescription("VOICE MESSAGE", substring = true))
                .performScrollTo().performClick()
            val anchor = compose.onNodeWithContentDescription("HOLD TO TALK").fetchSemanticsNode().boundsInRoot.center
            compose.onRoot().performTouchInput { down(anchor) }
            compose.waitUntil(3000) {
                compose.onAllNodesWithContentDescription("RELEASE TO SEND").fetchSemanticsNodes().isNotEmpty()
            }
            Thread.sleep(800)
            assertEquals(anchor.y, compose.onNodeWithContentDescription("RELEASE TO SEND")
                .fetchSemanticsNode().boundsInRoot.center.y, 1f)
            val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
            File(context.getExternalFilesDir(null), "ptt-native-wear-recording.png").outputStream().use { output ->
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
            }
            bitmap.recycle()
            compose.onRoot().performTouchInput { up() }
            // The demo owns no authenticated mailbox: honest send failure, not
            // a fabricated success and never an upload to a real recipient.
            compose.onNodeWithContentDescription("TRY AGAIN").assertExists()
            compose.onNodeWithContentDescription("RELEASE TO SEND").assertDoesNotExist()
            assertTrue(context.cacheDir.listFiles().orEmpty().none { file -> file.name.startsWith("wear-ptt-") })
            val retry = compose.onNodeWithContentDescription("TRY AGAIN").fetchSemanticsNode().boundsInRoot.center
            compose.onRoot().performTouchInput { down(retry) }
            compose.waitUntil(3000) {
                compose.onAllNodesWithContentDescription("RELEASE TO SEND").fetchSemanticsNodes().isNotEmpty()
            }
            compose.onRoot().performTouchInput { cancel() }
            compose.onNode(hasContentDescription("VOICE MESSAGE", substring = true)).assertExists()
            assertTrue(context.cacheDir.listFiles().orEmpty().none { file -> file.name.startsWith("wear-ptt-") })
        }
    }
}
