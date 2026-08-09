package io.agentmux.linkui

import com.adelost.ringkit.ui.PhoneHeaderAction
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.generated.GeneratedLinkChromeActions

/**
 * The settings-action component, rendered as phone header chrome and as the
 * round-surface row.
 *
 * Both read the SAME declared action, so the phone label and the wear row title
 * cannot drift apart: they are one product affordance shown on two surfaces, and
 * there is exactly one place that says what it is called.
 *
 * This file used to carry `LinkRoute.headerTitle` and `LinkRoute.headerIconId`
 * as extension properties, described in its own comment as "the one native copy
 * of each route's chrome". That copy is what SVW-0125 deletes: route identity
 * now comes from GeneratedLinkRoutes, emitted from routes.ts.
 *
 * Tapping must emit settings-action.open through the host graph; pass the
 * holder's emit.
 */
fun linkSettingsHeaderAction(onOpenSettings: () -> Unit): PhoneHeaderAction =
    with(GeneratedLinkChromeActions.OPEN_SETTINGS) {
        PhoneHeaderAction(
            icon = LinkNativeBindings.requireIcon(iconAssetRef),
            label = title,
            contentDescription = a11y,
            onTap = onOpenSettings,
        )
    }

/** The settings-action component rendered as the round-surface row. */
fun linkSettingsRow(onOpenSettings: () -> Unit): RowSpec =
    with(GeneratedLinkChromeActions.OPEN_SETTINGS) {
        RowSpec(
            key = rowKey,
            title = title,
            sub = detail,
            icon = LinkNativeBindings.requireIcon(iconAssetRef),
            onTap = onOpenSettings,
        )
    }
