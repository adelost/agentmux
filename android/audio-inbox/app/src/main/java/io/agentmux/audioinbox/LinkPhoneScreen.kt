package io.agentmux.audioinbox

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.adelost.designkit.ui.CircleSurfaceClass
import com.adelost.designkit.ui.LocalCircleSurfaceLayout
import com.adelost.ringkit.ui.CircleHostPreviewPort
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
    currentVersionName: String,
    hostPreview: CircleHostPreviewPort,
    onRequestMicrophone: () -> Unit,
    recordedBytes: () -> Long,
    recordedLevel: () -> Float,
    onPublicLink: () -> Unit,
) {
    val route by graph.activePage.collectAsStateWithLifecycle()
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
                    port = hostPreview,
                    inspections = graph.inspections,
                    onBack = { check(graph.navigation.back()) },
                )
            }
            LocalCircleSurfaceLayout.current.surfaceClass == CircleSurfaceClass.ROUND -> {
                LinkWatchSurface(
                    graph = graph,
                    currentVersionName = currentVersionName,
                    onRequestMicrophone = onRequestMicrophone,
                    recordedBytes = recordedBytes,
                    recordedLevel = recordedLevel,
                    onOpenDevHost = {
                        graph.onDevHostOpen(LinkRouteOpenEvent(LinkRoute.DEV_HOST))
                    },
                )
            }
            route == LinkRoute.SETTINGS -> {
                LinkPhoneSettings(
                    graph = graph,
                    currentVersionName = currentVersionName,
                    onBack = { check(graph.navigation.back()) },
                    onPublicLink = onPublicLink,
                )
            }
            else -> {
                LinkPhoneHome(
                    graph = graph,
                    onRequestMicrophone = onRequestMicrophone,
                    recordedBytes = recordedBytes,
                    recordedLevel = recordedLevel,
                )
            }
        }
    }
}
