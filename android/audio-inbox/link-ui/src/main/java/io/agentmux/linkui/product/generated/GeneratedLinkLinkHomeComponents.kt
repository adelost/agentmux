// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: 9dc2f17efa57eab612d3c63d9f483d8763c254f242b02071052c0d3f06afd1eb
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkLinkHomeComponent(val id: GeneratedLinkComponentId) {
    TARGET(GeneratedLinkComponentId.TARGET), TALK(GeneratedLinkComponentId.TALK), LATEST(GeneratedLinkComponentId.LATEST), SETTINGS_ACTION(GeneratedLinkComponentId.SETTINGS_ACTION), COMPOSER(GeneratedLinkComponentId.COMPOSER)
}
enum class GeneratedLinkLinkHomeRegion { CONTENT, CHROME, FOOTER, RAIL }

data class GeneratedLinkLinkHomeMount(
    val id: String,
    val component: GeneratedLinkLinkHomeComponent,
    val region: GeneratedLinkLinkHomeRegion,
    val order: Int,
    val priority: Int,
    val capacity: Int?,
    val required: Boolean,
)

data class GeneratedLinkLinkHomeTree(val mounts: List<GeneratedLinkLinkHomeMount>) {
    val orderedMounts: List<GeneratedLinkLinkHomeMount> = mounts.sortedWith(
        compareBy(GeneratedLinkLinkHomeMount::order).thenBy(GeneratedLinkLinkHomeMount::priority),
    )

    init {
        require(mounts.map { it.id }.distinct().size == mounts.size)
        require(mounts.map { it.region to it.order }.distinct().size == mounts.size)
        require(mounts == orderedMounts)
    }
}

object GeneratedLinkLinkHomeComponents {
    val declaredSurfaceClasses: Set<CircleSurfaceClass> = setOf(
        CircleSurfaceClass.ROUND,
        CircleSurfaceClass.PHONE_COMPACT,
        CircleSurfaceClass.PHONE_WIDE,
    )

    fun resolve(surfaceClass: CircleSurfaceClass): GeneratedLinkLinkHomeTree = when (surfaceClass) {
        CircleSurfaceClass.ROUND -> GeneratedLinkLinkHomeTree(listOf(
            GeneratedLinkLinkHomeMount(
                id = "target",
                component = GeneratedLinkLinkHomeComponent.TARGET,
                region = GeneratedLinkLinkHomeRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "talk",
                component = GeneratedLinkLinkHomeComponent.TALK,
                region = GeneratedLinkLinkHomeRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "latest",
                component = GeneratedLinkLinkHomeComponent.LATEST,
                region = GeneratedLinkLinkHomeRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "settings-action",
                component = GeneratedLinkLinkHomeComponent.SETTINGS_ACTION,
                region = GeneratedLinkLinkHomeRegion.CHROME,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkLinkHomeTree(listOf(
            GeneratedLinkLinkHomeMount(
                id = "target",
                component = GeneratedLinkLinkHomeComponent.TARGET,
                region = GeneratedLinkLinkHomeRegion.CONTENT,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "latest",
                component = GeneratedLinkLinkHomeComponent.LATEST,
                region = GeneratedLinkLinkHomeRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "composer",
                component = GeneratedLinkLinkHomeComponent.COMPOSER,
                region = GeneratedLinkLinkHomeRegion.FOOTER,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "talk",
                component = GeneratedLinkLinkHomeComponent.TALK,
                region = GeneratedLinkLinkHomeRegion.FOOTER,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "settings-action",
                component = GeneratedLinkLinkHomeComponent.SETTINGS_ACTION,
                region = GeneratedLinkLinkHomeRegion.CHROME,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkLinkHomeTree(listOf(
            GeneratedLinkLinkHomeMount(
                id = "target",
                component = GeneratedLinkLinkHomeComponent.TARGET,
                region = GeneratedLinkLinkHomeRegion.RAIL,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "latest",
                component = GeneratedLinkLinkHomeComponent.LATEST,
                region = GeneratedLinkLinkHomeRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "composer",
                component = GeneratedLinkLinkHomeComponent.COMPOSER,
                region = GeneratedLinkLinkHomeRegion.FOOTER,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "talk",
                component = GeneratedLinkLinkHomeComponent.TALK,
                region = GeneratedLinkLinkHomeRegion.FOOTER,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkLinkHomeMount(
                id = "settings-action",
                component = GeneratedLinkLinkHomeComponent.SETTINGS_ACTION,
                region = GeneratedLinkLinkHomeRegion.CHROME,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        else -> error("link.home does not serve $surfaceClass")
    }
}
