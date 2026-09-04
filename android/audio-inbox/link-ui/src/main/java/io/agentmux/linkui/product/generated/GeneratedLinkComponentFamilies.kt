// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: 83741324ee1b1e69992f0ff1b15fa53aa1ad2818a9aa13c73a0d398f384196f4
package io.agentmux.linkui.product.generated

enum class GeneratedLinkComponentFamilyRef(val wireId: String) { LINK_HOME("link.home"), LINK_SETTINGS("link.settings"), LINK_DEV_HOST("link.dev-host") }
enum class GeneratedLinkComponentTypeId(val wireId: String) { LINK_TARGET_PICKER("link.target-picker"), LINK_TALK("link.talk"), LINK_LATEST_TURN("link.latest-turn"), LINK_COMPOSER("link.composer"), LINK_ACTIVE_PLAYBACK("link.active-playback"), LINK_CONNECTION_STATUS("link.connection-status"), LINK_PUBLIC_LINK("link.public-link"), LINK_PREFERENCES("link.preferences"), LINK_LOCAL_HISTORY("link.local-history"), LINK_UPDATES("link.updates"), LINK_RECOVERY_STATUS("link.recovery-status"), LINK_PAGE_HOST("link.page-host"), LINK_NAVIGATION_ENTRY("link.navigation-entry"), LINK_DEV_HOST_ENTRY("link.dev-host-entry"), LINK_DEV_PREVIEW("link.dev-preview") }
enum class GeneratedLinkComponentId(val wireId: String, val type: GeneratedLinkComponentTypeId) {
    NAVIGATION_PAGE_HOST("navigation.page-host", GeneratedLinkComponentTypeId.LINK_PAGE_HOST), TARGET_PICKER("target.picker", GeneratedLinkComponentTypeId.LINK_TARGET_PICKER), CAPTURE_TALK("capture.talk", GeneratedLinkComponentTypeId.LINK_TALK), CONVERSATION_LATEST("conversation.latest", GeneratedLinkComponentTypeId.LINK_LATEST_TURN), CONVERSATION_COMPOSER("conversation.composer", GeneratedLinkComponentTypeId.LINK_COMPOSER), PLAYBACK_CONTROLS("playback.controls", GeneratedLinkComponentTypeId.LINK_ACTIVE_PLAYBACK), SESSION_CONNECTION("session.connection", GeneratedLinkComponentTypeId.LINK_CONNECTION_STATUS), SESSION_PUBLIC_LINK("session.public-link", GeneratedLinkComponentTypeId.LINK_PUBLIC_LINK), PREFERENCES_TOGGLES("preferences.toggles", GeneratedLinkComponentTypeId.LINK_PREFERENCES), HISTORY_LOCAL("history.local", GeneratedLinkComponentTypeId.LINK_LOCAL_HISTORY), UPDATES_PANEL("updates.panel", GeneratedLinkComponentTypeId.LINK_UPDATES), RECOVERY_STATUS("recovery.status", GeneratedLinkComponentTypeId.LINK_RECOVERY_STATUS), NAVIGATION_SETTINGS_ENTRY("navigation.settings-entry", GeneratedLinkComponentTypeId.LINK_NAVIGATION_ENTRY), NAVIGATION_DEV_HOST_ENTRY("navigation.dev-host-entry", GeneratedLinkComponentTypeId.LINK_DEV_HOST_ENTRY), DEV_PREVIEW("dev.preview", GeneratedLinkComponentTypeId.LINK_DEV_PREVIEW)
}
enum class GeneratedLinkArtifactRef(val wireId: String) { PHONE_FULL_UI("phone-full-ui"), WEAR_FULL_UI("wear-full-ui") }

data class GeneratedLinkComponentFamilyBinding(
    val route: GeneratedLinkPageId,
    val family: GeneratedLinkComponentFamilyRef,
    val components: Set<GeneratedLinkComponentId>,
)

object GeneratedLinkComponentFamilies {
    val bindings: Set<GeneratedLinkComponentFamilyBinding> = setOf(
        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkPageId.HOME,
            family = GeneratedLinkComponentFamilyRef.LINK_HOME,
            components = setOf(GeneratedLinkComponentId.NAVIGATION_PAGE_HOST, GeneratedLinkComponentId.TARGET_PICKER, GeneratedLinkComponentId.CAPTURE_TALK, GeneratedLinkComponentId.CONVERSATION_LATEST, GeneratedLinkComponentId.NAVIGATION_SETTINGS_ENTRY, GeneratedLinkComponentId.CONVERSATION_COMPOSER),
        ),
        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkPageId.SETTINGS,
            family = GeneratedLinkComponentFamilyRef.LINK_SETTINGS,
            components = setOf(GeneratedLinkComponentId.NAVIGATION_PAGE_HOST, GeneratedLinkComponentId.SESSION_CONNECTION, GeneratedLinkComponentId.UPDATES_PANEL, GeneratedLinkComponentId.NAVIGATION_DEV_HOST_ENTRY, GeneratedLinkComponentId.RECOVERY_STATUS, GeneratedLinkComponentId.PLAYBACK_CONTROLS, GeneratedLinkComponentId.SESSION_PUBLIC_LINK, GeneratedLinkComponentId.PREFERENCES_TOGGLES, GeneratedLinkComponentId.HISTORY_LOCAL),
        ),
        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkPageId.DEV_HOST,
            family = GeneratedLinkComponentFamilyRef.LINK_DEV_HOST,
            components = setOf(GeneratedLinkComponentId.NAVIGATION_PAGE_HOST, GeneratedLinkComponentId.DEV_PREVIEW),
        )
    )

    init {
        require(bindings.map { it.route }.distinct().size == bindings.size)
        require(bindings.map { it.family }.distinct().size == bindings.size)
        val mountedIdentities = bindings.flatMap { binding ->
            binding.components.map { component -> Triple(binding.route, binding.family, component) }
        }
        require(mountedIdentities.distinct().size == mountedIdentities.size)
    }
}
