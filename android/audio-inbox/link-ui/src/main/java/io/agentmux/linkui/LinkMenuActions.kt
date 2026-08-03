package io.agentmux.linkui

import androidx.compose.ui.graphics.vector.ImageVector
import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.ui.PhoneHeaderAction
import com.adelost.ringkit.ui.RowSpec

enum class LinkMenuAction {
    OPEN_SETTINGS,
}

private data class LinkMenuActionSpec(
    val action: LinkMenuAction,
    val title: String,
    val detail: String,
    val contentDescription: String,
    val icon: ImageVector,
)

private val settingsAction = LinkMenuActionSpec(
    action = LinkMenuAction.OPEN_SETTINGS,
    title = "SETTINGS",
    detail = "CONNECTION & AUDIO",
    contentDescription = "Open Link settings",
    icon = RingIcons.Gear,
)

fun LinkMenuAction.dispatch(onOpenSettings: () -> Unit) = when (this) {
    LinkMenuAction.OPEN_SETTINGS -> onOpenSettings()
}

fun linkSettingsHeaderAction(onAction: (LinkMenuAction) -> Unit) = PhoneHeaderAction(
    icon = settingsAction.icon,
    label = settingsAction.title,
    contentDescription = settingsAction.contentDescription,
    onTap = { onAction(settingsAction.action) },
)

fun linkSettingsRow(onAction: (LinkMenuAction) -> Unit) = RowSpec(
    key = "settings",
    title = settingsAction.title,
    sub = settingsAction.detail,
    icon = settingsAction.icon,
    onTap = { onAction(settingsAction.action) },
)
