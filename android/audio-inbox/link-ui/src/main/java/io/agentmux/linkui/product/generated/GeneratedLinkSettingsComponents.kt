// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ProductConfig.componentFamilies
// Product declarations SHA-256: 83741324ee1b1e69992f0ff1b15fa53aa1ad2818a9aa13c73a0d398f384196f4
package io.agentmux.linkui.product.generated

import com.adelost.designkit.ui.CircleSurfaceClass

enum class GeneratedLinkSettingsComponent(val id: GeneratedLinkComponentId) {
    NAVIGATION_PAGE_HOST(GeneratedLinkComponentId.NAVIGATION_PAGE_HOST), SESSION_CONNECTION(GeneratedLinkComponentId.SESSION_CONNECTION), UPDATES_PANEL(GeneratedLinkComponentId.UPDATES_PANEL), NAVIGATION_DEV_HOST_ENTRY(GeneratedLinkComponentId.NAVIGATION_DEV_HOST_ENTRY), RECOVERY_STATUS(GeneratedLinkComponentId.RECOVERY_STATUS), PLAYBACK_CONTROLS(GeneratedLinkComponentId.PLAYBACK_CONTROLS), SESSION_PUBLIC_LINK(GeneratedLinkComponentId.SESSION_PUBLIC_LINK), PREFERENCES_TOGGLES(GeneratedLinkComponentId.PREFERENCES_TOGGLES), HISTORY_LOCAL(GeneratedLinkComponentId.HISTORY_LOCAL)
}
enum class GeneratedLinkSettingsRegion { HOST, CONTENT, RAIL }

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
                id = "navigation.page-host",
                component = GeneratedLinkSettingsComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkSettingsRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "session.connection",
                component = GeneratedLinkSettingsComponent.SESSION_CONNECTION,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "updates.panel",
                component = GeneratedLinkSettingsComponent.UPDATES_PANEL,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "navigation.dev-host-entry",
                component = GeneratedLinkSettingsComponent.NAVIGATION_DEV_HOST_ENTRY,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = false,
            ),
            GeneratedLinkSettingsMount(
                id = "recovery.status",
                component = GeneratedLinkSettingsComponent.RECOVERY_STATUS,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 4,
                priority = 0,
                capacity = null,
                required = false,
            )
        ))
        CircleSurfaceClass.PHONE_COMPACT -> GeneratedLinkSettingsTree(listOf(
            GeneratedLinkSettingsMount(
                id = "navigation.page-host",
                component = GeneratedLinkSettingsComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkSettingsRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "playback.controls",
                component = GeneratedLinkSettingsComponent.PLAYBACK_CONTROLS,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 1,
                priority = 0,
                capacity = null,
                required = false,
            ),
            GeneratedLinkSettingsMount(
                id = "session.connection",
                component = GeneratedLinkSettingsComponent.SESSION_CONNECTION,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "session.public-link",
                component = GeneratedLinkSettingsComponent.SESSION_PUBLIC_LINK,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "preferences.toggles",
                component = GeneratedLinkSettingsComponent.PREFERENCES_TOGGLES,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "history.local",
                component = GeneratedLinkSettingsComponent.HISTORY_LOCAL,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 5,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "updates.panel",
                component = GeneratedLinkSettingsComponent.UPDATES_PANEL,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 6,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "navigation.dev-host-entry",
                component = GeneratedLinkSettingsComponent.NAVIGATION_DEV_HOST_ENTRY,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 7,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "recovery.status",
                component = GeneratedLinkSettingsComponent.RECOVERY_STATUS,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 8,
                priority = 0,
                capacity = null,
                required = false,
            )
        ))
        CircleSurfaceClass.PHONE_WIDE -> GeneratedLinkSettingsTree(listOf(
            GeneratedLinkSettingsMount(
                id = "navigation.page-host",
                component = GeneratedLinkSettingsComponent.NAVIGATION_PAGE_HOST,
                region = GeneratedLinkSettingsRegion.HOST,
                order = 0,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "playback.controls",
                component = GeneratedLinkSettingsComponent.PLAYBACK_CONTROLS,
                region = GeneratedLinkSettingsRegion.RAIL,
                order = 1,
                priority = 0,
                capacity = null,
                required = false,
            ),
            GeneratedLinkSettingsMount(
                id = "session.connection",
                component = GeneratedLinkSettingsComponent.SESSION_CONNECTION,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 2,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "session.public-link",
                component = GeneratedLinkSettingsComponent.SESSION_PUBLIC_LINK,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 3,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "preferences.toggles",
                component = GeneratedLinkSettingsComponent.PREFERENCES_TOGGLES,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 4,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "history.local",
                component = GeneratedLinkSettingsComponent.HISTORY_LOCAL,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 5,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "updates.panel",
                component = GeneratedLinkSettingsComponent.UPDATES_PANEL,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 6,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "navigation.dev-host-entry",
                component = GeneratedLinkSettingsComponent.NAVIGATION_DEV_HOST_ENTRY,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 7,
                priority = 0,
                capacity = null,
                required = true,
            ),
            GeneratedLinkSettingsMount(
                id = "recovery.status",
                component = GeneratedLinkSettingsComponent.RECOVERY_STATUS,
                region = GeneratedLinkSettingsRegion.CONTENT,
                order = 8,
                priority = 0,
                capacity = null,
                required = false,
            )
        ))
        else -> error("link.settings does not serve $surfaceClass")
    }
}
