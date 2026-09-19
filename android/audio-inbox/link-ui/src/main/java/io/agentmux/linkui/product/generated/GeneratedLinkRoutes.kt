// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the declared route identity (title and icon per screen)
// Product declarations SHA-256: 19c8418024765cee0f04b2a20a7f0cc17b973fadcc36e49c876fa5b75b980ad9
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
        GeneratedLinkPageId.WAKE_DEBUG -> GeneratedLinkRouteDescriptor(route, "WAKE DEBUG", "gauge")
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
