// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: ac2666eab12e029bbcc15961d131bb644ba80308e1f9a7e4d4a3fe534847bd37
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkHomeComponent(val id: GeneratedLinkComponentId) {
    PAGE_HOST(GeneratedLinkComponentId.PAGE_HOST), TARGET(GeneratedLinkComponentId.TARGET), TALK(GeneratedLinkComponentId.TALK), LATEST(GeneratedLinkComponentId.LATEST), SETTINGS_ACTION(GeneratedLinkComponentId.SETTINGS_ACTION), COMPOSER(GeneratedLinkComponentId.COMPOSER)
}
enum class GeneratedLinkHomeRegion { HOST, CONTENT, CHROME, FOOTER, RAIL }

data class GeneratedLinkHomeMount(
    val id: String,
    val component: GeneratedLinkHomeComponent,
    val region: GeneratedLinkHomeRegion,
    val order: Int,
    val priority: Int,
    val capacity: Int?,
    val required: Boolean,
)

data class GeneratedLinkHomeTree(val mounts: List<GeneratedLinkHomeMount>) {
    val orderedMounts: List<GeneratedLinkHomeMount> = mounts.sortedWith(
        compareBy(GeneratedLinkHomeMount::order).thenBy(GeneratedLinkHomeMount::priority),
    )

    init {
        require(mounts.map { it.id }.distinct().size == mounts.size)
        require(mounts.map { it.region to it.order }.distinct().size == mounts.size)
        require(mounts == orderedMounts)
    }
}

object GeneratedLinkHomeComponents {
    val declaredSurfaceClasses: Set<CircleSurfaceClass> = setOf(
        CircleSurfaceClass.ROUND,
        CircleSurfaceClass.PHONE_COMPACT,
        CircleSurfaceClass.PHONE_WIDE,
    )

    fun resolve(surfaceClass: CircleSurfaceClass): GeneratedLinkHomeTree = when (surfaceClass) {
        CircleSurfaceClass.ROUND -> GeneratedLinkHomeTree(listOf(
            GeneratedLinkHomeMount(
                id = "page-host",
                component = GeneratedLinkHomeComponent.PAGE_HOST,
                region = GeneratedLinkHomeRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "target",
                component = GeneratedLinkHomeComponent.TARGET,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "talk",
                component = GeneratedLinkHomeComponent.TALK,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "latest",
                component = GeneratedLinkHomeComponent.LATEST,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "settings-action",
                component = GeneratedLinkHomeComponent.SETTINGS_ACTION,
                region = GeneratedLinkHomeRegion.CHROME,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkHomeTree(listOf(
            GeneratedLinkHomeMount(
                id = "page-host",
                component = GeneratedLinkHomeComponent.PAGE_HOST,
                region = GeneratedLinkHomeRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "target",
                component = GeneratedLinkHomeComponent.TARGET,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "latest",
                component = GeneratedLinkHomeComponent.LATEST,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "composer",
                component = GeneratedLinkHomeComponent.COMPOSER,
                region = GeneratedLinkHomeRegion.FOOTER,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "talk",
                component = GeneratedLinkHomeComponent.TALK,
                region = GeneratedLinkHomeRegion.FOOTER,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "settings-action",
                component = GeneratedLinkHomeComponent.SETTINGS_ACTION,
                region = GeneratedLinkHomeRegion.CHROME,
                order = 5,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkHomeTree(listOf(
            GeneratedLinkHomeMount(
                id = "page-host",
                component = GeneratedLinkHomeComponent.PAGE_HOST,
                region = GeneratedLinkHomeRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "target",
                component = GeneratedLinkHomeComponent.TARGET,
                region = GeneratedLinkHomeRegion.RAIL,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "latest",
                component = GeneratedLinkHomeComponent.LATEST,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "composer",
                component = GeneratedLinkHomeComponent.COMPOSER,
                region = GeneratedLinkHomeRegion.FOOTER,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "talk",
                component = GeneratedLinkHomeComponent.TALK,
                region = GeneratedLinkHomeRegion.FOOTER,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "settings-action",
                component = GeneratedLinkHomeComponent.SETTINGS_ACTION,
                region = GeneratedLinkHomeRegion.CHROME,
                order = 5,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        else -> error("link.home does not serve $surfaceClass")
    }
}
