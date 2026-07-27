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

/**
 * App-local adaptation of Skyvw designkit Graphite tokens. Values and circular
 * hierarchy are traced in docs/AGENTMUX-LINK-UX-V2.md; no cross-repo runtime
 * dependency is introduced.
 */
internal object LinkTokens {
    val Canvas = Color(0xFF111315)
    val Surface = Color(0xFF1A1D20)
    val SurfaceStrong = Color(0xFF1D2023)
    val Border = Color(0x2EF1EFE9)
    val Ink = Color(0xFFF1EFE9)
    val Muted = Color(0xFFA4A49F)
    val Faint = Color(0xFF727579)
    val Accent = Color(0xFF6DE3B5)
    val AccentInk = Color(0xFF121719)
    val Warning = Color(0xFFE2AF32)
    val Error = Color(0xFFED6863)
    val PageGutter = 16.dp
    val Control = 48.dp
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
