// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the declared route identity (title and icon per screen)
// Product declarations SHA-256: 3e6765af21db604669c0439cc4633ff24f982312ca2bd565f392e435d1086de5
package io.agentmux.linkui.product.generated

enum class GeneratedLinkPageId(val wireId: String) {
    HOME("home"),
    SETTINGS("settings"),
    DEV_HOST("dev-host"),
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
