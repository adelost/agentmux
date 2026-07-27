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
import io.agentmux.linkcore.LinkVisualTokens

/**
 * App-local adaptation of Skyvw designkit Graphite tokens. Values and circular
 * hierarchy are traced in docs/AGENTMUX-LINK-UX-V2.md; no cross-repo runtime
 * dependency is introduced.
 */
internal object LinkTokens {
    val Canvas = Color(LinkVisualTokens.CANVAS_ARGB)
    val Surface = Color(LinkVisualTokens.SURFACE_ARGB)
    val SurfaceStrong = Color(LinkVisualTokens.SURFACE_STRONG_ARGB)
    val Border = Color(0x2EF1EFE9)
    val Ink = Color(LinkVisualTokens.INK_ARGB)
    val Muted = Color(LinkVisualTokens.MUTED_ARGB)
    val Faint = Color(0xFF727579)
    val Accent = Color(LinkVisualTokens.ACCENT_ARGB)
    val AccentInk = Color(LinkVisualTokens.ACCENT_INK_ARGB)
    val Warning = Color(LinkVisualTokens.WARNING_ARGB)
    val Error = Color(LinkVisualTokens.ERROR_ARGB)
    val PageGutter = LinkVisualTokens.PAGE_GUTTER_DP.dp
    val Control = LinkVisualTokens.MIN_TOUCH_DP.dp
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
