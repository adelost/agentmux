package io.agentmux.audioinbox

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import com.adelost.ringkit.ui.CircleHostPreviewPort
import com.adelost.ringkit.ui.RenderRingScreen
import com.adelost.ringkit.ui.RingNavigator
import com.adelost.ringkit.ui.RingScreen
import com.adelost.ringkit.ui.RowSpec
import com.adelost.ringkit.ui.circleHostPreviewScreen
import io.agentmux.linkui.linkProductPortRows
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.generated.GeneratedLinkRoutes
import io.agentmux.linkui.product.ProductPortInspection
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The dev-host route: the shared CircleKit host preview plus the product port
 * inspector fed by the exact runtime store.
 */
@Composable
internal fun LinkDevHostScreen(
    port: CircleHostPreviewPort,
    inspections: Flow<List<ProductPortInspection>>,
    onBack: () -> Unit,
) {
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
    BackHandler(onBack = onBack)
    RenderRingScreen(nav = navigator, backLabel = "Back", onExit = onBack)
}
