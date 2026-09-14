package io.agentmux.linkui

import androidx.compose.ui.graphics.Color
import com.adelost.designkit.ui.CircleAccent
import com.adelost.designkit.ui.circleAccentColor
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

class LinkSenderAccentTest {
    private val senderColours = (0..200).flatMap { listOf("claw:$it", "lsrc:$it", "skyvw:$it") }
        .map(::linkSenderAccent).toSet()

    @Test fun aSenderNeverReadsAsYourOwnNeutralMessage() {
        senderColours.forEach { accent ->
            assertTrue("$accent is too pale to tell from YOU", saturation(circleAccentColor(accent)) >= 0.3f)
        }
    }

    @Test fun twoSendersEitherShareAColourOrLookClearlyDifferent() {
        senderColours.forEach { a ->
            (senderColours - a).forEach { b ->
                assertTrue("$a and $b look alike", hueDistance(circleAccentColor(a), circleAccentColor(b)) >= 40f)
            }
        }
    }

    @Test fun neighbouringPanesInOneProjectGetDifferentColours() {
        (0..8).forEach { assertNotEquals(linkSenderAccent("claw:$it"), linkSenderAccent("claw:${it + 1}")) }
    }

    @Test fun attentionAndMutedColoursNeverNameAPane() {
        assertTrue(senderColours.none { it in setOf(CircleAccent.NEUTRAL, CircleAccent.CLOUD, CircleAccent.CAUTION, CircleAccent.DANGER) })
    }

    private fun saturation(c: Color): Float {
        val hi = max(c.red, max(c.green, c.blue))
        return if (hi == 0f) 0f else (hi - min(c.red, min(c.green, c.blue))) / hi
    }

    private fun hue(c: Color): Float {
        val hi = max(c.red, max(c.green, c.blue))
        val d = hi - min(c.red, min(c.green, c.blue))
        if (d == 0f) return 0f
        val h = when (hi) {
            c.red -> ((c.green - c.blue) / d).mod(6f)
            c.green -> (c.blue - c.red) / d + 2f
            else -> (c.red - c.green) / d + 4f
        }
        return h * 60f
    }

    private fun hueDistance(a: Color, b: Color): Float = abs(hue(a) - hue(b)).let { min(it, 360f - it) }
}
