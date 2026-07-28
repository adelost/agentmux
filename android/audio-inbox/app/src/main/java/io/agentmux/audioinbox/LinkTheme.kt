package io.agentmux.audioinbox

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.adelost.designkit.ui.GraphiteMetrics
import com.adelost.designkit.ui.GraphiteTokens

/**
 * Link's names for CircleKit's canonical Graphite palette.
 *
 * These values used to be traced by hand into link-core so the two apps would
 * "look the same" without a shared dependency — and the accent had already
 * drifted (0xFF6DE3B5 against Graphite's 0xFF79B8B4). Naming the tokens is
 * fine; owning a second copy of their values is what drifts.
 *
 * Two values move by adopting the canonical set: the accent, and the page
 * gutter (16dp to Graphite's 20dp). Both are deliberate — a shared design
 * system that lets each app keep its own spacing is just two design systems.
 */
internal object LinkTokens {
    val Canvas = GraphiteTokens.Canvas
    val Surface = GraphiteTokens.Surface
    val SurfaceStrong = GraphiteTokens.SurfaceStrong
    val Border = GraphiteTokens.BorderStrong
    val Ink = GraphiteTokens.Ink
    val Muted = GraphiteTokens.Muted
    val Faint = GraphiteTokens.Faint
    val Accent = GraphiteTokens.Primary
    val AccentInk = GraphiteTokens.PrimaryInk
    val Warning = GraphiteTokens.Orange
    val Error = GraphiteTokens.Red
    val PageGutter = GraphiteMetrics.PageGutter
    val Control = GraphiteMetrics.ControlHeight
}

@Composable
internal fun AgentmuxLinkTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = LinkTokens.Accent,
            onPrimary = LinkTokens.AccentInk,
            background = LinkTokens.Canvas,
            onBackground = LinkTokens.Ink,
            surface = LinkTokens.Surface,
            onSurface = LinkTokens.Ink,
            error = LinkTokens.Error,
        ),
        content = content,
    )
}

@Composable
internal fun CircularControl(
    diameter: Dp,
    active: Boolean,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(diameter)
            .clip(CircleShape)
            .background(if (active) LinkTokens.Accent else LinkTokens.SurfaceStrong)
            .border(
                BorderStroke(1.dp, if (active) LinkTokens.Accent else LinkTokens.Border),
                CircleShape,
            ),
    ) {
        content()
    }
}
