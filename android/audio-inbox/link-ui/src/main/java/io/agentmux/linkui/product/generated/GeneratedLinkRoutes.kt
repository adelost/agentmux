// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the declared route identity (title and icon per screen)
// Product declarations SHA-256: 505eb28b27b81c9432aade659b5767082c914f06e900911eb05219a1fb066ee4
package io.agentmux.linkui.product.generated

enum class GeneratedLinkPageId(val wireId: String) {
    HOME("home"),
    SETTINGS("settings"),
    DEV_HOST("dev-host"),
}

data class GeneratedLinkRouteDescriptor(
    val route: GeneratedLinkPageId,
    val title: String,
    val iconId: String,
)

object GeneratedLinkRoutes {
    fun descriptor(route: GeneratedLinkPageId): GeneratedLinkRouteDescriptor = when (route) {
        GeneratedLinkPageId.HOME -> GeneratedLinkRouteDescriptor(route, "AGENTMUX LINK", "route.home")
        GeneratedLinkPageId.SETTINGS -> GeneratedLinkRouteDescriptor(route, "LINK SETTINGS", "route.settings")
        GeneratedLinkPageId.DEV_HOST -> GeneratedLinkRouteDescriptor(route, "DEV HOST", "route.dev-host")
    }
}

data class GeneratedLinkChromeAction(
    val id: String,
    val rowKey: String,
    val title: String,
    val detail: String,
    val a11y: String,
    val iconAssetRef: String,
)

object GeneratedLinkChromeActions {
    val OPEN_SETTINGS: GeneratedLinkChromeAction = GeneratedLinkChromeAction(
        "open-settings",
        "settings",
        "SETTINGS",
        "CONNECTION & AUDIO",
        "Open Link settings",
        "gear",
    )
}
