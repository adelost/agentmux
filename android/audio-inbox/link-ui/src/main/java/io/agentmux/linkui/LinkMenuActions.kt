package io.agentmux.linkui

import com.adelost.ringkit.ui.PhoneHeaderAction
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkui.product.LinkProductSession
import io.agentmux.linkui.product.generated.LinkMenuAction
import io.agentmux.linkui.product.generated.LinkRoute

fun LinkMenuAction.dispatch(
    product: LinkProductSession,
    onNavigate: (LinkRoute) -> Unit,
) = onNavigate(product.action(this).destination)

fun linkSettingsHeaderAction(
    product: LinkProductSession,
    onAction: (LinkMenuAction) -> Unit,
): PhoneHeaderAction {
    val descriptor = product.action(LinkMenuAction.OPEN_SETTINGS)
    return PhoneHeaderAction(
        icon = product.icon(descriptor.iconId),
        label = descriptor.title,
        contentDescription = descriptor.contentDescription,
        onTap = { onAction(descriptor.action) },
    )
}

fun linkSettingsRow(
    product: LinkProductSession,
    onAction: (LinkMenuAction) -> Unit,
): RowSpec {
    val descriptor = product.action(LinkMenuAction.OPEN_SETTINGS)
    return RowSpec(
        key = descriptor.rowId,
        title = descriptor.title,
        sub = descriptor.detail,
        icon = product.icon(descriptor.iconId),
        onTap = { onAction(descriptor.action) },
    )
}
