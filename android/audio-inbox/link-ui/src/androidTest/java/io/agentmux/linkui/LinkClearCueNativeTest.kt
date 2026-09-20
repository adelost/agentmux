package io.agentmux.linkui

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.test.down
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.up
import androidx.compose.ui.unit.dp
import androidx.test.platform.app.InstrumentationRegistry
import com.adelost.designkit.ui.GraphiteTokens
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.designkit.ui.RingIcons
import com.adelost.designkit.ui.circleResolvedTiming
import com.adelost.designkit.ui.resolveCircleSurfaceLayout
import com.adelost.ringkit.ui.RingRow
import io.agentmux.linkui.product.generated.GeneratedLinkHistoryStatus
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * WHAT: Checks Link's only deliberate control on a real Android frame clock.
 * WHY: Keeps its visible cue, accepted action and haptic on one declared gate.
 */
class LinkClearCueNativeTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun clearDrawsTheGateItKeeps() {
        val haptics = RecordingHaptics()
        var clears = 0
        val row = requireNotNull(linkClearConversationRow(
            history = GeneratedLinkHistoryStatus(2, 20, "lsrc:3", 2),
            icon = RingIcons.Trash,
            onClear = { clears++ },
        ))
        compose.setContent {
            CompositionLocalProvider(
                LocalCircleSurfaceLayout provides resolveCircleSurfaceLayout(390f, 844f, false),
                LocalHapticFeedback provides haptics,
            ) {
                Column(Modifier.fillMaxSize().background(GraphiteTokens.Canvas)) {
                    RingRow(
                        title = row.title,
                        sub = row.sub,
                        icon = row.icon,
                        onTap = row.onTap,
                        labelProgress = row.labelProgress,
                        holdToConfirm = row.holdToConfirm,
                        holdMs = row.holdMs,
                        timing = circleResolvedTiming(row.actionTiming, row.holdMs),
                        hint = row.hint,
                        multiline = row.multiline,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
            }
        }
        val control = compose.onAllNodesWithContentDescription("CLEAR lsrc:3", substring = true).onFirst()
        compose.waitForIdle()
        val rest = frame("rest")

        compose.mainClock.autoAdvance = false
        control.performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(120L)
        val early = frame("held-120ms")
        compose.mainClock.advanceTimeBy(320L)
        val later = frame("held-440ms")

        val earlyPixels = changed(rest, early)
        val laterPixels = changed(rest, later)
        assertTrue(
            "the Android host drew no CLEAR cue after the brush minimum: early=$earlyPixels",
            earlyPixels > 0,
        )
        assertTrue(
            "the Android host's CLEAR cue did not advance: early=$earlyPixels later=$laterPixels",
            changed(early, later) > 0,
        )

        control.performTouchInput { up() }
        compose.mainClock.autoAdvance = true
        compose.waitForIdle()
        frame("released")
        assertEquals("an early release cleared the conversation", 0, clears)
        assertEquals("an early release emitted haptic feedback", emptyList<HapticFeedbackType>(), haptics.events)

        compose.mainClock.autoAdvance = false
        control.performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        compose.mainClock.advanceTimeBy(row.holdMs + 32L)
        assertEquals("one completed host gate did not clear exactly once", 1, clears)
        assertEquals(
            "one completed host gate did not emit exactly one destructive haptic",
            listOf(HapticFeedbackType.LongPress),
            haptics.events,
        )
        control.performTouchInput { up() }
    }

    private fun frame(name: String): Bitmap {
        val view = compose.activity.findViewById<android.view.View>(android.R.id.content)
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        instrumentation.runOnMainSync { view.draw(Canvas(bitmap)) }
        val output = File(instrumentation.targetContext.getExternalFilesDir(null), "row215-clear-$name.png")
        output.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    private fun changed(before: Bitmap, after: Bitmap): Int {
        require(before.width == after.width && before.height == after.height)
        val beforePixels = IntArray(before.width * before.height)
        val afterPixels = IntArray(after.width * after.height)
        before.getPixels(beforePixels, 0, before.width, 0, 0, before.width, before.height)
        after.getPixels(afterPixels, 0, after.width, 0, 0, after.width, after.height)
        return beforePixels.indices.count { beforePixels[it] != afterPixels[it] }
    }

    private class RecordingHaptics : HapticFeedback {
        val events = mutableListOf<HapticFeedbackType>()
        override fun performHapticFeedback(hapticFeedbackType: HapticFeedbackType) {
            events += hapticFeedbackType
        }
    }
}
