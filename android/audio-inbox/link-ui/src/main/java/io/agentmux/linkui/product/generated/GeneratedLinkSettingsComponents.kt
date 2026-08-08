// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: 9dc2f17efa57eab612d3c63d9f483d8763c254f242b02071052c0d3f06afd1eb
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkSettingsComponent(val id: GeneratedLinkComponentId) {
    CONNECTION(GeneratedLinkComponentId.CONNECTION), UPDATES(GeneratedLinkComponentId.UPDATES), DEV_HOST(GeneratedLinkComponentId.DEV_HOST), RECOVERY(GeneratedLinkComponentId.RECOVERY), ACTIVE_PLAYBACK(GeneratedLinkComponentId.ACTIVE_PLAYBACK), PUBLIC_LINK(GeneratedLinkComponentId.PUBLIC_LINK), PREFERENCES(GeneratedLinkComponentId.PREFERENCES), LOCAL_HISTORY(GeneratedLinkComponentId.LOCAL_HISTORY)
}
enum class GeneratedLinkSettingsRegion { CONTENT, RAIL }

data class GeneratedLinkSettingsMount(
    val id: String,
    val component: GeneratedLinkSettingsComponent,
    val region: GeneratedLinkSettingsRegion,
    val order: Int,
    val priority: Int,
    val capacity: Int?,
    val required: Boolean,
)

data class GeneratedLinkSettingsTree(val mounts: List<GeneratedLinkSettingsMount>) {
    val orderedMounts: List<GeneratedLinkSettingsMount> = mounts.sortedWith(
        compareBy(GeneratedLinkSettingsMount::order).thenBy(GeneratedLinkSettingsMount::priority),
    )

    init {
        require(mounts.map { it.id }.distinct().size == mounts.size)
        require(mounts.map { it.region to it.order }.distinct().size == mounts.size)
        require(mounts == orderedMounts)
    }
}

object GeneratedLinkSettingsComponents {
    val declaredSurfaceClasses: Set<CircleSurfaceClass> = setOf(
        CircleSurfaceClass.ROUND,
        CircleSurfaceClass.PHONE_COMPACT,
        CircleSurfaceClass.PHONE_WIDE,
    )

    fun resolve(surfaceClass: CircleSurfaceClass): GeneratedLinkSettingsTree = when (surfaceClass) {
        CircleSurfaceClass.ROUND -> GeneratedLinkSettingsTree(listOf(
            GeneratedLinkSettingsMount(
                id = "connection",
                component = GeneratedLinkSettingsComponent.CONNECTION,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "updates",
                component = GeneratedLinkSettingsComponent.UPDATES,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "dev-host",
                component = GeneratedLinkSettingsComponent.DEV_HOST,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = false,
            ),
            GeneratedLinkSettingsMount(
                id = "recovery",
                component = GeneratedLinkSettingsComponent.RECOVERY,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = false,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkSettingsTree(listOf(
            GeneratedLinkSettingsMount(
                id = "active-playback",
                component = GeneratedLinkSettingsComponent.ACTIVE_PLAYBACK,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = false,
            ),
            GeneratedLinkSettingsMount(
                id = "connection",
                component = GeneratedLinkSettingsComponent.CONNECTION,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "public-link",
                component = GeneratedLinkSettingsComponent.PUBLIC_LINK,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "preferences",
                component = GeneratedLinkSettingsComponent.PREFERENCES,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "local-history",
                component = GeneratedLinkSettingsComponent.LOCAL_HISTORY,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "updates",
                component = GeneratedLinkSettingsComponent.UPDATES,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 5,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "dev-host",
                component = GeneratedLinkSettingsComponent.DEV_HOST,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 6,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "recovery",
                component = GeneratedLinkSettingsComponent.RECOVERY,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 7,
                priority = 0,
                capacity = null,
                required = false,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkSettingsTree(listOf(
            GeneratedLinkSettingsMount(
                id = "active-playback",
                component = GeneratedLinkSettingsComponent.ACTIVE_PLAYBACK,
                region = GeneratedLinkSettingsRegion.RAIL,
                order = 0,
                priority = 0,
                capacity = null,
                required = false,
            ),
            GeneratedLinkSettingsMount(
                id = "connection",
                component = GeneratedLinkSettingsComponent.CONNECTION,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "public-link",
                component = GeneratedLinkSettingsComponent.PUBLIC_LINK,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "preferences",
                component = GeneratedLinkSettingsComponent.PREFERENCES,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "local-history",
                component = GeneratedLinkSettingsComponent.LOCAL_HISTORY,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "updates",
                component = GeneratedLinkSettingsComponent.UPDATES,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 5,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "dev-host",
                component = GeneratedLinkSettingsComponent.DEV_HOST,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 6,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "recovery",
                component = GeneratedLinkSettingsComponent.RECOVERY,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 7,
                priority = 0,
                capacity = null,
                required = false,
            )
        ))
        else -> error("link.settings does not serve $surfaceClass")
    }
}
