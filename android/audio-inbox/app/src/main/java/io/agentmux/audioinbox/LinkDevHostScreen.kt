package io.agentmux.audioinbox

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.adelost.ringkit.ui.CircleHostPreviewPort
import com.adelost.ringkit.ui.RenderRingScreen
import com.adelost.ringkit.ui.RingNavigator
import com.adelost.ringkit.ui.circleHostPreviewScreen

/** Renders the shared DEV host contract; no Link-specific preview renderer exists. */
@Composable
internal fun LinkDevHostScreen(
    port: CircleHostPreviewPort,
    onBack: () -> Unit,
) {
    val navigator = remember(port) { RingNavigator(circleHostPreviewScreen(port)) }
    BackHandler(onBack = onBack)
    RenderRingScreen(nav = navigator, onExit = onBack)
}
