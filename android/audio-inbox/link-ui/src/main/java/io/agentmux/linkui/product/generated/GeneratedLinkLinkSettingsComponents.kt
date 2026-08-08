// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: 9dc2f17efa57eab612d3c63d9f483d8763c254f242b02071052c0d3f06afd1eb
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkLinkSettingsComponent(val id: GeneratedLinkComponentId) {
    CONNECTION(GeneratedLinkComponentId.CONNECTION), UPDATES(GeneratedLinkComponentId.UPDATES), DEV_HOST(GeneratedLinkComponentId.DEV_HOST), RECOVERY(GeneratedLinkComponentId.RECOVERY), ACTIVE_PLAYBACK(GeneratedLinkComponentId.ACTIVE_PLAYBACK), PUBLIC_LINK(GeneratedLinkComponentId.PUBLIC_LINK), PREFERENCES(GeneratedLinkComponentId.PREFERENCES), LOCAL_HISTORY(GeneratedLinkComponentId.LOCAL_HISTORY)
}
enum class GeneratedLinkLinkSettingsRegion { CONTENT, RAIL }

data class GeneratedLinkLinkSettingsMount(
    val id: String,
    val component: GeneratedLinkLinkSettingsComponent,
    val region: GeneratedLinkLinkSettingsRegion,
    val order: Int,
    val priority: Int,
    val capacity: Int?,
    val required: Boolean,
)

data class GeneratedLinkLinkSettingsTree(val mounts: List<GeneratedLinkLinkSettingsMount>) {
    val orderedMounts: List<GeneratedLinkLinkSettingsMount> = mounts.sortedWith(
        compareBy(GeneratedLinkLinkSettingsMount::order).thenBy(GeneratedLinkLinkSettingsMount::priority),
    )

    init {
        require(mounts.map { it.id }.distinct().size == mounts.size)
        require(mounts.map { it.region to it.order }.distinct().size == mounts.size)
        require(mounts == orderedMounts)
    }
}

object GeneratedLinkLinkSettingsComponents {
    val declaredSurfaceClasses: Set<CircleSurfaceClass> = setOf(
        CircleSurfaceClass.ROUND,
        CircleSurfaceClass.PHONE_COMPACT,
        CircleSurfaceClass.PHONE_WIDE,
    )

    fun resolve(surfaceClass: CircleSurfaceClass): GeneratedLinkLinkSettingsTree = when (surfaceClass) {
        CircleSurfaceClass.ROUND -> GeneratedLinkLinkSettingsTree(listOf(
            GeneratedLinkLinkSettingsMount(
                id = "connection",
                component = GeneratedLinkLinkSettingsComponent.CONNECTION,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "updates",
                component = GeneratedLinkLinkSettingsComponent.UPDATES,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "dev-host",
                component = GeneratedLinkLinkSettingsComponent.DEV_HOST,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = false,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "recovery",
                component = GeneratedLinkLinkSettingsComponent.RECOVERY,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = false,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkLinkSettingsTree(listOf(
            GeneratedLinkLinkSettingsMount(
                id = "active-playback",
                component = GeneratedLinkLinkSettingsComponent.ACTIVE_PLAYBACK,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = false,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "connection",
                component = GeneratedLinkLinkSettingsComponent.CONNECTION,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "public-link",
                component = GeneratedLinkLinkSettingsComponent.PUBLIC_LINK,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "preferences",
                component = GeneratedLinkLinkSettingsComponent.PREFERENCES,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "local-history",
                component = GeneratedLinkLinkSettingsComponent.LOCAL_HISTORY,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "updates",
                component = GeneratedLinkLinkSettingsComponent.UPDATES,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 5,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "dev-host",
                component = GeneratedLinkLinkSettingsComponent.DEV_HOST,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 6,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "recovery",
                component = GeneratedLinkLinkSettingsComponent.RECOVERY,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 7,
                priority = 0,
                capacity = null,
                required = false,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkLinkSettingsTree(listOf(
            GeneratedLinkLinkSettingsMount(
                id = "active-playback",
                component = GeneratedLinkLinkSettingsComponent.ACTIVE_PLAYBACK,
                region = GeneratedLinkLinkSettingsRegion.RAIL,
                order = 0,
                priority = 0,
                capacity = null,
                required = false,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "connection",
                component = GeneratedLinkLinkSettingsComponent.CONNECTION,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "public-link",
                component = GeneratedLinkLinkSettingsComponent.PUBLIC_LINK,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "preferences",
                component = GeneratedLinkLinkSettingsComponent.PREFERENCES,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "local-history",
                component = GeneratedLinkLinkSettingsComponent.LOCAL_HISTORY,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "updates",
                component = GeneratedLinkLinkSettingsComponent.UPDATES,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 5,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "dev-host",
                component = GeneratedLinkLinkSettingsComponent.DEV_HOST,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 6,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkSettingsMount(
                id = "recovery",
                component = GeneratedLinkLinkSettingsComponent.RECOVERY,
                region = GeneratedLinkLinkSettingsRegion.CONTENT,
                order = 7,
                priority = 0,
                capacity = null,
                required = false,
            )
        ))
        else -> error("link.settings does not serve $surfaceClass")
    }
}
