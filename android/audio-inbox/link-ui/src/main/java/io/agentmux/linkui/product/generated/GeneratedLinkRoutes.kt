// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the declared route identity (title and icon per screen)
// Product declarations SHA-256: e6150cfb9a457d5a11067e0bb3b5e52e71dccd94750818c8c7f67737af69dad5
package io.agentmux.linkui.product.generated

enum class GeneratedLinkPageId(val wireId: String) {
    HOME("home"),
    SETTINGS("settings"),
    DEV_HOST("dev-host"),
    WAKE_DEBUG("wake-debug"),
    WAKE_TRY("wake-try"),
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
        GeneratedLinkPageId.WAKE_DEBUG -> GeneratedLinkRouteDescriptor(route, "WAKE DEBUG", "gauge")
        GeneratedLinkPageId.WAKE_TRY -> GeneratedLinkRouteDescriptor(route, "TRY THE WAKE WORD", "target")
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
