package io.agentmux.linkui

import com.adelost.ringkit.ui.PhoneHeaderAction
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.LinkRoute

/** The one native copy of each route's chrome; the generated trees carry no titles. */
val LinkRoute.headerTitle: String
    get() = when (this) {
        LinkRoute.HOME -> "AGENTMUX LINK"
        LinkRoute.SETTINGS -> "LINK SETTINGS"
        LinkRoute.DEV_HOST -> "DEV HOST"
    }

/** The attested icon asset behind each route's chrome. */
val LinkRoute.headerIconId: String
    get() = when (this) {
        LinkRoute.HOME -> "link"
        LinkRoute.SETTINGS -> "gear"
        LinkRoute.DEV_HOST -> "phone"
    }

/**
 * The settings-action component rendered as phone header chrome. Tapping must
 * emit settings-action.open through the host graph; pass the holder's emit.
 */
fun linkSettingsHeaderAction(onOpenSettings: () -> Unit): PhoneHeaderAction =
    PhoneHeaderAction(
        icon = LinkNativeBindings.requireIcon("gear"),
        label = "SETTINGS",
        contentDescription = "Open Link settings",
        onTap = onOpenSettings,
    )

/** The settings-action component rendered as the round-surface row. */
fun linkSettingsRow(onOpenSettings: () -> Unit): RowSpec = RowSpec(
    key = "settings",
    title = "SETTINGS",
    sub = "CONNECTION & AUDIO",
    icon = LinkNativeBindings.requireIcon("gear"),
    onTap = onOpenSettings,
)
