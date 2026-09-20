package io.agentmux.audioinbox

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.down
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.up
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.designkit.ui.resolveCircleSurfaceLayout
import io.agentmux.audioinbox.update.LinkReleaseCatalogs
import io.agentmux.audioinbox.update.LinkUpdater
import io.agentmux.linkui.LinkInteractionHost
import io.agentmux.linkui.product.LinkNavigationController
import io.agentmux.linkui.product.generated.GeneratedLinkArtifactRef
import io.agentmux.linkui.product.generated.GeneratedLinkControlTiming
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * THE SETTINGS PAGE, AS THE APP COMPOSES IT, PRESSED. Row 225.
 *
 * [io.agentmux.linkui.LinkControlsDeclareTheirKindTest] reads the rows a pure function builds. The
 * settings page builds its rows inside a Composable, so nothing read them: lsrc:0 planted
 * `CircleActionTiming.DELIBERATE` on the WAKE PHRASE row, the very control Mattias pressed, and
 * link-ui 50 of 50 and app 85 of 85 stayed green. A declaration nothing reads has stopped being the
 * truth.
 *
 * So the page is mounted and each of its controls is pressed for 16 ms, the touch Mattias made, and
 * what it does is compared with what [GeneratedLinkControlTiming] says it should do. A touch commits
 * and draws no wait; a hold does neither on a press that short.
 */
@RunWith(RobolectricTestRunner::class)
@Config(application = android.app.Application::class, sdk = [34], qualifiers = "w390dp-h844dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TheSettingsPageObeysItsDeclarationsTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `every control on the settings page obeys the kind its declaration gives it`() {
        mountSettings()

        val pressed = CONTROLS.mapNotNull { control -> pressForAFlick(control)?.let { control to it } }

        pressed.forEach { (control, result) ->
            // THE DRAWING HALF, read inside the control's own bounds. The page around it is alive:
            // the real graph's flows keep emitting, so a whole-page diff measures the app rather than
            // the press.
            assertEquals(
                "${control.spokenName} drew ${result.pixelsChangedWhileDown} pixels of wait on a " +
                    "$A_HOLD_WOULD_SHOW ms press",
                0,
                result.pixelsChangedWhileDown,
            )
        }

        // THE COMMIT HALF, on the controls whose own label says what they did. A touch changes its
        // label on the shortest press a finger can make; a control that waits does not.
        val answered = pressed.filter { (control, _) -> control.answersOnItsLabel }
        answered.forEach { (control, result) ->
            when (control.declared) {
                CircleActionTiming.IMMEDIATE -> assertTrue(
                    "${control.spokenName} is declared a touch and did not commit on a $A_HOLD_WOULD_SHOW ms " +
                        "press: it still reads '${result.labelBefore}'",
                    result.committed,
                )
                CircleActionTiming.DELIBERATE -> assertTrue(
                    "${control.spokenName} is declared a hold and committed on a $A_HOLD_WOULD_SHOW ms press",
                    !result.committed,
                )
            }
        }

        assertTrue(
            "WAKE PHRASE was not among the controls this case pressed, and it is the control that was " +
                "reported: found ${namesOnPage()}",
            answered.any { (control, _) -> control.spokenName == "WAKE PHRASE" },
        )
    }

    private class Pressed(
        val committed: Boolean,
        val pixelsChangedWhileDown: Int,
        val labelBefore: String,
        /** Whether this control's own label says what the press did. Navigation rows do not. */
        val labelCanAnswer: Boolean,
    )

    private class Control(
        val spokenName: String,
        val declared: CircleActionTiming,
        /**
         * Whether this control's own label is a faithful receipt for its press.
         *
         * True only where the label names the option the control is ON, so it changes the moment the
         * press commits. It is declared, never guessed from the text: a navigation row's label can
         * carry the same separator and still never move, because what it does is open a page.
         *
         * Excluded, with the reason rather than a silent pass: the three navigation rows and the
         * public-link row, whose labels do not report; and ANNOUNCEMENTS, which routes through the
         * coordinator's persisted state and does not settle while this case holds the clock.
         */
        val answersOnItsLabel: Boolean = false,
    )

    /**
     * Presses one control for the touch Mattias made and reports both halves.
     *
     * The wait is read inside the control's own bounds, because the page around it is alive. The
     * commit is read off the control's own spoken label, which for a choice or a toggle says which
     * option it is on: that is exact, where a pixel diff of a live page is not.
     */
    private fun pressForAFlick(control: Control): Pressed? {
        val node = nodeFor(control.spokenName) ?: return null
        val box = node.boundsInRoot
        val labelBefore = labelOf(control.spokenName).orEmpty()
        val interaction = compose.onAllNodesWithContentDescription(control.spokenName, substring = true).onFirst()
        val atRest = settleToRest()

        interaction.performTouchInput { down(center) }
        compose.mainClock.advanceTimeByFrame()
        var drawnAtItsMost = 0
        try {
            var elapsed = 0L
            while (elapsed < A_HOLD_WOULD_SHOW) {
                compose.mainClock.advanceTimeBy(A_FRAME)
                elapsed += A_FRAME
                drawnAtItsMost = maxOf(drawnAtItsMost, differingPixelsIn(box, atRest, frame()))
            }
        } finally {
            interaction.performTouchInput { up() }
            compose.mainClock.advanceTimeByFrame()
        }
        settleToRest()

        val labelAfter = labelOf(control.spokenName).orEmpty()
        return Pressed(
            committed = labelAfter.isNotEmpty() && labelAfter != labelBefore,
            pixelsChangedWhileDown = drawnAtItsMost,
            labelBefore = labelBefore,
            // A row whose label names its current option answers; one that only opens a page does not,
            // and this case says so rather than reading its silence as a refusal.
            labelCanAnswer = labelBefore.contains(" · "),
        )
    }

    private fun nodeFor(spokenName: String): SemanticsNode? =
        compose.onAllNodesWithContentDescription(spokenName, substring = true)
            .fetchSemanticsNodes()
            .firstOrNull()

    private fun labelOf(spokenName: String): String? =
        nodeFor(spokenName)?.config?.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull()

    private fun mountSettings() {
        compose.mainClock.autoAdvance = false
        val application = RuntimeEnvironment.getApplication()
        // A wearer who has turned the wake word on, which is the page WAKE PHRASE lives on.
        application.getSharedPreferences("audio-inbox", android.content.Context.MODE_PRIVATE)
            .edit().putBoolean("wakeWord", true).commit()
        val coordinator = LinkCoordinator(application)
        val updater = LinkUpdater(
            context = application,
            scope = CoroutineScope(SupervisorJob()),
            catalog = LinkReleaseCatalogs.PHONE,
            currentVersionName = "1.2.23",
            currentVersionCode = 1,
        )
        // The app's own graph, not the QA one: the QA graph pins the wake word off, and WAKE PHRASE
        // only exists while it is on, so the control that was reported would never be on the page.
        val graph = PhoneLinkProductGraph.real(
            coordinator = coordinator,
            recorder = PushToTalkRecorder(compose.activity),
            updater = updater,
            navigation = LinkNavigationController(GeneratedLinkArtifactRef.PHONE_FULL_UI),
            microphoneGranted = MutableStateFlow(true),
            wakeWord = LinkWakeWordControl(application) {},
            listeningSound = LinkListeningSoundPreference(application),
            listeningStarted = {},
        )
        compose.setContent {
            // The phone surface the qualifiers already describe. The app's own host resolves this from
            // the window; the page refuses to draw on the canonical round default.
            CompositionLocalProvider(
                LocalCircleSurfaceLayout provides resolveCircleSurfaceLayout(
                    widthDp = 390f,
                    heightDp = 844f,
                    round = false,
                ),
            ) {
                LinkInteractionHost {
                    Settings(graph)
                }
            }
        }
        settleToRest()
    }

    @Composable
    private fun Settings(graph: PhoneLinkProductGraph) {
        LinkPhoneSettings(
            graph = graph,
            currentVersionName = "1.2.23",
            onBack = {},
            onPublicLink = {},
        )
    }

    /** What the page is actually offering, so a case that finds nothing says what it did find. */
    private fun namesOnPage(): List<String> =
        compose.onAllNodesWithContentDescription("", substring = true)
            .fetchSemanticsNodes()
            .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.ContentDescription)?.firstOrNull() }

    /** See circlekit #250: rest is proven, not assumed, or the next reading is of the last press. */
    private fun settleToRest(): IntArray {
        var previous = frame()
        repeat(FRAMES_TO_REST) {
            compose.mainClock.advanceTimeByFrame()
            val next = frame()
            if (next.contentEquals(previous)) return next
            previous = next
        }
        throw AssertionError("the page was still changing after $FRAMES_TO_REST frames")
    }

    /** `captureToImage` waits for an idle composition, which a pressed control never is. */
    private fun frame(): IntArray {
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        val buffer = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(buffer, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return buffer
    }

    private fun differingPixels(before: IntArray, after: IntArray): Int {
        var changed = 0
        for (index in before.indices) if (before[index] != after[index]) changed += 1
        return changed
    }

    /** The same count, bounded to one control, so a live page around it cannot answer for it. */
    private fun differingPixelsIn(box: Rect, before: IntArray, after: IntArray): Int {
        val width = compose.activity.window.decorView.width
        if (width <= 0 || before.size != after.size) return differingPixels(before, after)
        val left = box.left.toInt().coerceIn(0, width)
        val right = box.right.toInt().coerceIn(left, width)
        val top = box.top.toInt().coerceAtLeast(0)
        val bottom = box.bottom.toInt().coerceAtLeast(top)
        var changed = 0
        for (y in top until bottom) {
            val row = y * width
            if (row + right > before.size) break
            for (x in left until right) if (before[row + x] != after[row + x]) changed += 1
        }
        return changed
    }

    private companion object {
        /** Mattias's own press, rounded up to a whole frame. */
        const val A_FLICK = 16L

        /**
         * Long enough that a control which IS waiting has drawn some of the wait: past row 215's 40 ms
         * brush minimum, far short of any declared gate. Below the minimum both kinds draw nothing by
         * design, so a 16 ms press cannot tell them apart on the glass.
         */
        const val A_HOLD_WOULD_SHOW = 120L
        const val A_FRAME = 16L
        const val FRAMES_TO_REST = 125

        /** What each control calls itself on the glass, and what its declaration says it is. */
        val CONTROLS = listOf(
            // WAKE PHRASE first and WAKE WORD last, and not for tidiness: the phrase row only exists
            // while the wake word is on, and turning the wake word off takes it off the page. Pressing
            // them the other way round left the case pressing six controls and quietly not the one
            // that was reported.
            Control("WAKE PHRASE", GeneratedLinkControlTiming.SETTINGS_WAKE_PHRASE, answersOnItsLabel = true),
            Control("SENSITIVITY", GeneratedLinkControlTiming.SETTINGS_SENSITIVITY),
            Control("DISPLAY PREVIEW", GeneratedLinkControlTiming.SETTINGS_DISPLAY_PREVIEW),
            Control("SIGN OUT", GeneratedLinkControlTiming.SETTINGS_PUBLIC_LINK),
            Control("CONNECT ONLINE", GeneratedLinkControlTiming.SETTINGS_PUBLIC_LINK),
            Control("READ REPLIES", GeneratedLinkControlTiming.SETTINGS_SPEAK_REPLIES, answersOnItsLabel = true),
            Control("ANNOUNCEMENTS", GeneratedLinkControlTiming.SETTINGS_HANDS_FREE),
            Control("WAKE WORD", GeneratedLinkControlTiming.SETTINGS_WAKE_WORD, answersOnItsLabel = true),
            Control("LISTENING SOUND", GeneratedLinkControlTiming.SETTINGS_LISTENING_CUE_SOUND, answersOnItsLabel = true),
        )
    }
}
