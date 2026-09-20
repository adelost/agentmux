package io.agentmux.audioinbox

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.test.down
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.up
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.designkit.ui.RingIcons
import com.adelost.designkit.ui.resolveCircleSurfaceLayout
import io.agentmux.linkui.linkClearConversationRow
import io.agentmux.linkui.product.generated.GeneratedLinkHistoryStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The real Link caller proves that its visible wait and accepted press are one gate. Row 215. */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, sdk = [34], qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TheClearConversationShowsItsGateTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `clear fills while held, rejects an early release, and confirms once at completion`() {
        val haptics = RecordingHaptics()
        var clears = 0
        val row = requireNotNull(linkClearConversationRow(
            history = GeneratedLinkHistoryStatus(
                retainedTurns = 2,
                maxTurns = 20,
                targetId = "lsrc:3",
                clearableTurns = 2,
            ),
            icon = RingIcons.Trash,
            onClear = { clears++ },
        ))
        compose.mainClock.autoAdvance = false
        compose.setContent {
            CompositionLocalProvider(
                LocalCircleSurfaceLayout provides resolveCircleSurfaceLayout(
                    widthDp = 390f,
                    heightDp = 844f,
                    round = false,
                ),
                LocalHapticFeedback provides haptics,
            ) {
                PhoneRow(row)
            }
        }

        val control = compose.onAllNodesWithContentDescription("CLEAR lsrc:3", substring = true).onFirst()
        val bounds = control.fetchSemanticsNode().boundsInRoot
        val rest = settleToRest()

        control.performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(120L)
        val earlyPixels = differingPixelsIn(bounds, rest, frame())
        compose.mainClock.advanceTimeBy(320L)
        val laterPixels = differingPixelsIn(bounds, rest, frame())
        control.performTouchInput { up() }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()

        assertTrue("the real CLEAR row drew no cue after the brush minimum", earlyPixels > 0)
        assertTrue("the real CLEAR row did not fill further while the same gate elapsed", laterPixels > earlyPixels)
        assertEquals("an early release cleared the conversation", 0, clears)
        assertEquals("an early release emitted haptic feedback", emptyList<HapticFeedbackType>(), haptics.events)
        val releasedRest = settleToRest()
        assertEquals(
            "the cue did not return to rest inside the real CLEAR row after release",
            0,
            differingPixelsIn(bounds, rest, releasedRest),
        )

        compose.mainClock.autoAdvance = false
        control.performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(row.holdMs + 32L)

        assertEquals("one completed gate did not clear exactly once", 1, clears)
        assertEquals("one completed gate did not emit exactly one haptic", listOf(HapticFeedbackType.LongPress), haptics.events)
        control.performTouchInput { up() }
    }

    private fun settleToRest(): IntArray {
        var previous = frame()
        repeat(REST_FRAME_LIMIT) {
            compose.mainClock.advanceTimeByFrame()
            val next = frame()
            if (next.contentEquals(previous)) return next
            previous = next
        }
        throw AssertionError("the mounted Link row did not settle within $REST_FRAME_LIMIT frames")
    }

    private fun frame(): IntArray {
        val view = compose.activity.findViewById<android.view.View>(android.R.id.content)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        return IntArray(bitmap.width * bitmap.height).also { pixels ->
            bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
            bitmap.recycle()
        }
    }

    private fun differingPixelsIn(bounds: Rect, before: IntArray, after: IntArray): Int {
        val width = compose.activity.findViewById<android.view.View>(android.R.id.content).width
        val left = bounds.left.toInt().coerceIn(0, width)
        val right = bounds.right.toInt().coerceIn(left, width)
        val top = bounds.top.toInt().coerceAtLeast(0)
        val bottom = bounds.bottom.toInt().coerceAtLeast(top)
        var changed = 0
        for (y in top until bottom) {
            val row = y * width
            if (row + right > before.size || row + right > after.size) break
            for (x in left until right) if (before[row + x] != after[row + x]) changed++
        }
        return changed
    }

    private class RecordingHaptics : HapticFeedback {
        val events = mutableListOf<HapticFeedbackType>()
        override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
            events += hapticFeedbackType
        }
    }

    private companion object {
        const val REST_FRAME_LIMIT = 125
    }
}
