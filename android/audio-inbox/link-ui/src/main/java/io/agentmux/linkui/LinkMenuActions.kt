package io.agentmux.linkui

import com.adelost.ringkit.ui.PhoneHeaderAction
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkui.product.LinkNativeBindings
import io.agentmux.linkui.product.generated.GeneratedLinkChromeActions
import io.agentmux.linkui.product.generated.GeneratedLinkControlTiming

/** WHAT: Builds the Phone settings action. WHY: Keeps header timing and copy on the generated declaration. */
fun linkSettingsHeaderAction(onOpenSettings: () -> Unit): PhoneHeaderAction =
    with(GeneratedLinkChromeActions.OPEN_SETTINGS) {
        PhoneHeaderAction(
            icon = LinkNativeBindings.requireIcon(iconAssetRef),
            label = title,
            contentDescription = a11y,
            timing = GeneratedLinkControlTiming.CHROME_OPEN_SETTINGS,
            onTap = onOpenSettings,
        )
    }

/** WHAT: Builds the round settings row. WHY: Keeps both hosts on the same declared action. */
fun linkSettingsRow(onOpenSettings: () -> Unit): RowSpec =
    with(GeneratedLinkChromeActions.OPEN_SETTINGS) {
        RowSpec(
            key = rowKey,
            title = title,
            sub = detail,
            icon = LinkNativeBindings.requireIcon(iconAssetRef),
            onTap = onOpenSettings,
            actionTiming = GeneratedLinkControlTiming.CHROME_OPEN_SETTINGS,
        )
    }
