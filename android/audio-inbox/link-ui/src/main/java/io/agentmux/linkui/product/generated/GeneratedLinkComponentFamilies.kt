// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: ac2666eab12e029bbcc15961d131bb644ba80308e1f9a7e4d4a3fe534847bd37
package io.agentmux.linkui.product.generated

enum class GeneratedLinkComponentFamilyRef(val wireId: String) { LINK_HOME("link.home"), LINK_SETTINGS("link.settings"), LINK_DEV_HOST("link.dev-host") }
enum class GeneratedLinkComponentTypeId(val wireId: String) { LINK_TARGET_PICKER("link.target-picker"), LINK_TALK("link.talk"), LINK_LATEST_TURN("link.latest-turn"), LINK_COMPOSER("link.composer"), LINK_ACTIVE_PLAYBACK("link.active-playback"), LINK_CONNECTION_STATUS("link.connection-status"), LINK_PUBLIC_LINK("link.public-link"), LINK_PREFERENCES("link.preferences"), LINK_LOCAL_HISTORY("link.local-history"), LINK_UPDATES("link.updates"), LINK_RECOVERY_STATUS("link.recovery-status"), LINK_PAGE_HOST("link.page-host"), LINK_NAVIGATION_ENTRY("link.navigation-entry"), LINK_DEV_HOST_ENTRY("link.dev-host-entry"), LINK_DEV_PREVIEW("link.dev-preview") }
enum class GeneratedLinkComponentId(val wireId: String, val type: GeneratedLinkComponentTypeId) {
    PAGE_HOST("page-host", GeneratedLinkComponentTypeId.LINK_PAGE_HOST), TARGET("target", GeneratedLinkComponentTypeId.LINK_TARGET_PICKER), TALK("talk", GeneratedLinkComponentTypeId.LINK_TALK), LATEST("latest", GeneratedLinkComponentTypeId.LINK_LATEST_TURN), COMPOSER("composer", GeneratedLinkComponentTypeId.LINK_COMPOSER), ACTIVE_PLAYBACK("active-playback", GeneratedLinkComponentTypeId.LINK_ACTIVE_PLAYBACK), CONNECTION("connection", GeneratedLinkComponentTypeId.LINK_CONNECTION_STATUS), PUBLIC_LINK("public-link", GeneratedLinkComponentTypeId.LINK_PUBLIC_LINK), PREFERENCES("preferences", GeneratedLinkComponentTypeId.LINK_PREFERENCES), LOCAL_HISTORY("local-history", GeneratedLinkComponentTypeId.LINK_LOCAL_HISTORY), UPDATES("updates", GeneratedLinkComponentTypeId.LINK_UPDATES), RECOVERY("recovery", GeneratedLinkComponentTypeId.LINK_RECOVERY_STATUS), SETTINGS_ACTION("settings-action", GeneratedLinkComponentTypeId.LINK_NAVIGATION_ENTRY), DEV_HOST("dev-host", GeneratedLinkComponentTypeId.LINK_DEV_HOST_ENTRY), DEV_PREVIEW("dev-preview", GeneratedLinkComponentTypeId.LINK_DEV_PREVIEW)
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
            components = setOf(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkComponentId.TARGET, GeneratedLinkComponentId.TALK, GeneratedLinkComponentId.LATEST, GeneratedLinkComponentId.SETTINGS_ACTION, GeneratedLinkComponentId.COMPOSER),
        ),
        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkPageId.SETTINGS,
            family = GeneratedLinkComponentFamilyRef.LINK_SETTINGS,
            components = setOf(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkComponentId.CONNECTION, GeneratedLinkComponentId.UPDATES, GeneratedLinkComponentId.DEV_HOST, GeneratedLinkComponentId.RECOVERY, GeneratedLinkComponentId.ACTIVE_PLAYBACK, GeneratedLinkComponentId.PUBLIC_LINK, GeneratedLinkComponentId.PREFERENCES, GeneratedLinkComponentId.LOCAL_HISTORY),
        ),
        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkPageId.DEV_HOST,
            family = GeneratedLinkComponentFamilyRef.LINK_DEV_HOST,
            components = setOf(GeneratedLinkComponentId.PAGE_HOST, GeneratedLinkComponentId.DEV_PREVIEW),
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
