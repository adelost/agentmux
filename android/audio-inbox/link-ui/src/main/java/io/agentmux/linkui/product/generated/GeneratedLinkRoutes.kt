// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the declared route identity (title and icon per screen)
// Product declarations SHA-256: acd94dabb89f47ca0e4b8f1a19265843836effc3788984247683c4466c14c5c2
package io.agentmux.linkui.product.generated

import io.agentmux.linkui.product.LinkRoute

data class GeneratedLinkRouteDescriptor(
    val route: LinkRoute,
    val title: String,
    val iconId: String,
)

object GeneratedLinkRoutes {
    fun descriptor(route: LinkRoute): GeneratedLinkRouteDescriptor = when (route) {
        LinkRoute.HOME -> GeneratedLinkRouteDescriptor(route, "AGENTMUX LINK", "route.home")
        LinkRoute.SETTINGS -> GeneratedLinkRouteDescriptor(route, "LINK SETTINGS", "route.settings")
        LinkRoute.DEV_HOST -> GeneratedLinkRouteDescriptor(route, "DEV HOST", "route.dev-host")
    }
}
