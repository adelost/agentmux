// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: 83741324ee1b1e69992f0ff1b15fa53aa1ad2818a9aa13c73a0d398f384196f4
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkHomeComponent(val id: GeneratedLinkComponentId) {
    NAVIGATION_PAGE_HOST(GeneratedLinkComponentId.NAVIGATION_PAGE_HOST), TARGET_PICKER(GeneratedLinkComponentId.TARGET_PICKER), CAPTURE_TALK(GeneratedLinkComponentId.CAPTURE_TALK), CONVERSATION_LATEST(GeneratedLinkComponentId.CONVERSATION_LATEST), NAVIGATION_SETTINGS_ENTRY(GeneratedLinkComponentId.NAVIGATION_SETTINGS_ENTRY), CONVERSATION_COMPOSER(GeneratedLinkComponentId.CONVERSATION_COMPOSER)
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
                id = "navigation.page-host",
                component = GeneratedLinkHomeComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkHomeRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "target.picker",
                component = GeneratedLinkHomeComponent.TARGET_PICKER,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "capture.talk",
                component = GeneratedLinkHomeComponent.CAPTURE_TALK,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "conversation.latest",
                component = GeneratedLinkHomeComponent.CONVERSATION_LATEST,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "navigation.settings-entry",
                component = GeneratedLinkHomeComponent.NAVIGATION_SETTINGS_ENTRY,
                region = GeneratedLinkHomeRegion.CHROME,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkHomeTree(listOf(
            GeneratedLinkHomeMount(
                id = "navigation.page-host",
                component = GeneratedLinkHomeComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkHomeRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "target.picker",
                component = GeneratedLinkHomeComponent.TARGET_PICKER,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "conversation.latest",
                component = GeneratedLinkHomeComponent.CONVERSATION_LATEST,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "conversation.composer",
                component = GeneratedLinkHomeComponent.CONVERSATION_COMPOSER,
                region = GeneratedLinkHomeRegion.FOOTER,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "capture.talk",
                component = GeneratedLinkHomeComponent.CAPTURE_TALK,
                region = GeneratedLinkHomeRegion.FOOTER,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "navigation.settings-entry",
                component = GeneratedLinkHomeComponent.NAVIGATION_SETTINGS_ENTRY,
                region = GeneratedLinkHomeRegion.CHROME,
                order = 5,
                priority = 0,
                capacity = null,
                required = true,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkHomeTree(listOf(
            GeneratedLinkHomeMount(
                id = "navigation.page-host",
                component = GeneratedLinkHomeComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkHomeRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "target.picker",
                component = GeneratedLinkHomeComponent.TARGET_PICKER,
                region = GeneratedLinkHomeRegion.RAIL,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "conversation.latest",
                component = GeneratedLinkHomeComponent.CONVERSATION_LATEST,
                region = GeneratedLinkHomeRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "conversation.composer",
                component = GeneratedLinkHomeComponent.CONVERSATION_COMPOSER,
                region = GeneratedLinkHomeRegion.FOOTER,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "capture.talk",
                component = GeneratedLinkHomeComponent.CAPTURE_TALK,
                region = GeneratedLinkHomeRegion.FOOTER,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkHomeMount(
                id = "navigation.settings-entry",
                component = GeneratedLinkHomeComponent.NAVIGATION_SETTINGS_ENTRY,
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
