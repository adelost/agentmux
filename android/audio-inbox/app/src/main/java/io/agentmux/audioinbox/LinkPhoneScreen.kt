package io.agentmux.audioinbox

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.adelost.designkit.ui.CircleSurfaceClass
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.ringkit.ui.RingActionCueHost
import io.agentmux.linkui.LinkWatchSurface
import io.agentmux.linkui.product.LinkRoute
import io.agentmux.linkui.product.LinkRouteOpenEvent
import io.agentmux.linkui.product.generated.GeneratedLinkDevHostComponent
import io.agentmux.linkui.product.generated.GeneratedLinkDevHostComponents

/**
 * Link owns state and callbacks only. CircleKit owns the host, rows, choices,
 * composer and press-lifecycle pixels on the phone exactly as it does on Wear.
 * All product state and actions flow through the graph holder.
 */
@Composable
internal fun LinkPhoneScreen(
    graph: PhoneLinkProductGraph,
) {
    val rendererRegistrations = remember(graph) { graph.nativePhoneRendererRegistrations() }
    check(rendererRegistrations.isNotEmpty())
    val route by graph.activePage.collectAsStateWithLifecycle()
    val devPreview by graph.devPreviewRenderInputs.collectAsStateWithLifecycle()
    BackHandler(route != LinkRoute.HOME) {
        check(graph.navigation.back())
    }
    RingActionCueHost {
        when {
            route == LinkRoute.DEV_HOST -> {
                check(
                    GeneratedLinkDevHostComponents
                        .resolve(LocalCircleSurfaceLayout.current.surfaceClass)
                        .orderedMounts.single {
                            it.component == GeneratedLinkDevHostComponent.DEV_PREVIEW
                        }.component == GeneratedLinkDevHostComponent.DEV_PREVIEW,
                )
                LinkDevHostScreen(
                    inputs = devPreview,
                    emitter = graph.devPreviewRenderEmitter,
                )
            }
            LocalCircleSurfaceLayout.current.surfaceClass == CircleSurfaceClass.ROUND -> {
                LinkWatchSurface(
                    graph = graph,
                    onOpenDevHost = {
                        graph.onDevHostOpen(LinkRouteOpenEvent(LinkRoute.DEV_HOST))
                    },
                )
            }
            route == LinkRoute.SETTINGS -> {
                LinkPhoneSettings(
                    graph = graph,
                    onBack = { check(graph.navigation.back()) },
                )
            }
            else -> {
                LinkPhoneHome(
                    graph = graph,
                )
            }
        }
    }
}
