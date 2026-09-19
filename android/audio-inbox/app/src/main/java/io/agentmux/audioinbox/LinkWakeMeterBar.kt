package io.agentmux.audioinbox

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.unit.dp
import com.adelost.designkit.ui.MenuDesign
import com.adelost.designkit.ui.phoneSurfaceDesign
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.Dp
import io.agentmux.wakeword.WAKE_CHUNK_MS

/** The bar's own shape: tall enough to read at a glance, and marks that overhang it so they are visible. */
internal val METER_HEIGHT = 12.dp
internal val TICK_WIDTH = 2.dp
internal val TICK_OVERHANG = 3.dp

/** Twelve and a half readings a second is the loop's own rate; a page redraws with it, not faster. */
internal const val TRACE_REFRESH_MS = WAKE_CHUNK_MS.toLong()

/**
 * The design system has no meter, so it has no token for the part of a bar that is empty. The dimmest
 * text colour is still far too loud for it: at full strength the track reads as a full bar.
 */
internal fun meterTrack(bright: Color): Color = bright.copy(alpha = 0.16f)

/** One mark across the bar, at a probability's own place on it. */
internal fun DrawScope.tick(at: Float, color: Color, size: Size) {
    val x = size.width * at.coerceIn(0f, 1f)
    drawLine(
        color = color,
        start = Offset(x, -TICK_OVERHANG.toPx()),
        end = Offset(x, size.height + TICK_OVERHANG.toPx()),
        strokeWidth = TICK_WIDTH.toPx(),
    )
}

/**
 * Where a row's words start: its own padding, the icon a meter block does not have, and the gap after
 * it. A page has one left edge for everything that carries meaning, so a block that is not a row lines
 * up with the rows above and below it. The numbers are this surface's own, which is why they come from
 * the phone design rather than from the shared menu metrics.
 */
@Composable
internal fun meterTextInset(): Dp = MenuDesign.rowPaddingH + phoneSurfaceDesign().let { it.rowIconDiameter + it.rowIconTextGap }
