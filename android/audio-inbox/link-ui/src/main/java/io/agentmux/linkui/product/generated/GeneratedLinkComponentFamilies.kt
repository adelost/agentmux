// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: 9dc2f17efa57eab612d3c63d9f483d8763c254f242b02071052c0d3f06afd1eb
package io.agentmux.linkui.product.generated

enum class GeneratedLinkRouteRef(val wireId: String) { HOME("home"), SETTINGS("settings"), DEV_HOST("dev-host") }
enum class GeneratedLinkComponentFamilyRef(val wireId: String) { LINK_HOME("link.home"), LINK_SETTINGS("link.settings"), LINK_DEV_HOST("link.dev-host") }
enum class GeneratedLinkComponentId(val wireId: String) { TARGET("target"), TALK("talk"), LATEST("latest"), COMPOSER("composer"), ACTIVE_PLAYBACK("active-playback"), CONNECTION("connection"), PUBLIC_LINK("public-link"), PREFERENCES("preferences"), LOCAL_HISTORY("local-history"), UPDATES("updates"), RECOVERY("recovery"), SETTINGS_ACTION("settings-action"), DEV_HOST("dev-host"), DEV_PREVIEW("dev-preview") }
enum class GeneratedLinkArtifactRef(val wireId: String) { PHONE_FULL_UI("phone-full-ui"), WEAR_FULL_UI("wear-full-ui") }

data class GeneratedLinkComponentFamilyBinding(
    val route: GeneratedLinkRouteRef,
    val family: GeneratedLinkComponentFamilyRef,
    val components: Set<GeneratedLinkComponentId>,
)

object GeneratedLinkComponentFamilies {
    val bindings: Set<GeneratedLinkComponentFamilyBinding> = setOf(
        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkRouteRef.HOME,
            family = GeneratedLinkComponentFamilyRef.LINK_HOME,
            components = setOf(GeneratedLinkComponentId.TARGET, GeneratedLinkComponentId.TALK, GeneratedLinkComponentId.LATEST, GeneratedLinkComponentId.SETTINGS_ACTION, GeneratedLinkComponentId.COMPOSER),
        ),
        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkRouteRef.SETTINGS,
            family = GeneratedLinkComponentFamilyRef.LINK_SETTINGS,
            components = setOf(GeneratedLinkComponentId.CONNECTION, GeneratedLinkComponentId.UPDATES, GeneratedLinkComponentId.DEV_HOST, GeneratedLinkComponentId.RECOVERY, GeneratedLinkComponentId.ACTIVE_PLAYBACK, GeneratedLinkComponentId.PUBLIC_LINK, GeneratedLinkComponentId.PREFERENCES, GeneratedLinkComponentId.LOCAL_HISTORY),
        ),
        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkRouteRef.DEV_HOST,
            family = GeneratedLinkComponentFamilyRef.LINK_DEV_HOST,
            components = setOf(GeneratedLinkComponentId.DEV_PREVIEW),
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
