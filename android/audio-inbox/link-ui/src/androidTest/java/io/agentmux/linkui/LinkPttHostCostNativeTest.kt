package io.agentmux.linkui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.down
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.up
import com.adelost.designkit.ui.CircleActionHostCost
import com.adelost.designkit.ui.LocalCircleActionHostCost
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.designkit.ui.resolveCircleSurfaceLayout
import io.agentmux.linkcore.CapturePhase
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

/**
 * WHAT: Checks Link's untimed push-to-talk gesture on a worn host.
 * WHY: Keeps host touch cost from becoming a confirmation gate before recording begins.
 */
class LinkPttHostCostNativeTest {

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun aShortPressBeginsOnDownAndReleasesWithoutAnArmingGate() {
        var begins = 0
        var releases = 0
        var cancels = 0
        compose.setContent {
            CompositionLocalProvider(
                LocalCircleSurfaceLayout provides resolveCircleSurfaceLayout(192f, 192f, true),
                LocalCircleActionHostCost provides CircleActionHostCost.WORN,
            ) {
                LinkCaptureControl(
                    spec = LinkCaptureSpec(
                        phase = CapturePhase.IDLE,
                        startedAtMs = 0L,
                        availability = LinkCaptureAvailability.Ready,
                    ),
                    recordedBytes = { 0L },
                    recordedLevel = { 0f },
                    onBegin = { begins++; true },
                    onRelease = { releases++ },
                    onCancel = { cancels++ },
                )
            }
        }

        compose.onNodeWithContentDescription("HOLD TO TALK").performTouchInput {
            down(center)
            advanceEventTime(40L)
            up()
        }
        compose.waitForIdle()

        assertEquals("push-to-talk gained an arming gate before recording", 1, begins)
        assertEquals("the lifecycle did not end on finger release", 1, releases)
        assertEquals("an ordinary finger release was misreported as cancellation", 0, cancels)
    }
}
