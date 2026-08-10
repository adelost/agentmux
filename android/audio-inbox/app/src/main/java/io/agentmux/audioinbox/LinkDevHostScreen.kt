package io.agentmux.audioinbox

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import com.adelost.ringkit.ui.RenderRingScreen
import com.adelost.ringkit.ui.RingNavigator
import com.adelost.ringkit.ui.RingScreen
import com.adelost.ringkit.ui.RowSpec
import com.adelost.ringkit.ui.circleHostPreviewScreen
import io.agentmux.linkui.linkProductPortRows
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes
import io.agentmux.linkui.product.LinkNavigationBackEvent
import io.agentmux.linkui.product.generated.GeneratedDevPreviewRenderEmitter
import io.agentmux.linkui.product.generated.GeneratedDevPreviewRenderInputs
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The dev-host route: the shared CircleKit host preview plus the product port
 * inspector fed by the exact runtime store.
 */
@Composable
internal fun LinkDevHostScreen(
    inputs: GeneratedDevPreviewRenderInputs,
    emitter: GeneratedDevPreviewRenderEmitter,
) {
    val port = requireNotNull(inputs.model.previewPort) { "Phone dev preview has no host port" }
    val inspections = inputs.model.portInspections
    val items = remember { MutableStateFlow(emptyList<RowSpec>()) }
    val navigator = remember {
        RingNavigator(
            RingScreen.Rows(
                title = GeneratedLinkRoutes.descriptor(LinkRoute.DEV_HOST).title,
                items = items,
                showBack = true,
            ),
        )
    }
    LaunchedEffect(port, inspections) {
        items.value = listOf(
            RowSpec(
                key = "host-preview",
                title = "HOST PREVIEW",
                sub = "RESPONSIVE · WATCH EXACT",
                icon = LinkNativeBindings.requireIcon("phone"),
                onTap = { navigator.push(circleHostPreviewScreen(port)) },
            ),
            RowSpec(
                key = "product-ports",
                title = "PRODUCT PORTS",
                sub = "SERVICE · COMPONENT GRAPH",
                icon = LinkNativeBindings.requireIcon("activity"),
                onTap = { navigator.push(linkProductPortRows(inspections, navigator::push)) },
            ),
        )
    }
    val onBack = { emitter.back(LinkNavigationBackEvent) }
    BackHandler(onBack = onBack)
    RenderRingScreen(nav = navigator, onExit = onBack)
}
