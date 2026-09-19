// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the declared route identity (title and icon per screen)
// Product declarations SHA-256: de4db3548015187943bf0ea389a0d5734ce0121271c94acdc5fdfd2074c4e2d6
package io.agentmux.linkui.product.generated

enum class GeneratedLinkPageId(val wireId: String) {
    HOME("home"),
    SETTINGS("settings"),
    DEV_HOST("dev-host"),
    WAKE_DEBUG("wake-debug"),
}

data class GeneratedLinkRouteDescriptor(
    val route: GeneratedLinkPageId,
    val title: String,
    val iconAssetRef: String,
)

object GeneratedLinkRoutes {
    fun descriptor(route: GeneratedLinkPageId): GeneratedLinkRouteDescriptor = when (route) {
        GeneratedLinkPageId.HOME -> GeneratedLinkRouteDescriptor(route, "LINK", "link")
        GeneratedLinkPageId.SETTINGS -> GeneratedLinkRouteDescriptor(route, "SETTINGS", "gear")
        GeneratedLinkPageId.DEV_HOST -> GeneratedLinkRouteDescriptor(route, "DISPLAY PREVIEW", "phone")
        GeneratedLinkPageId.WAKE_DEBUG -> GeneratedLinkRouteDescriptor(route, "WAKE DEBUG", "activity")
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
        "Connection, sound & updates",
        "Open Link settings",
        "gear",
    )
}
