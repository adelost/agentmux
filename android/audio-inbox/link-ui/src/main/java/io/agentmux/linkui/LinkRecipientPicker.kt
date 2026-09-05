package io.agentmux.linkui

import androidx.compose.runtime.Composable
import androidx.activity.compose.BackHandler
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.ui.RingSelectionOption
import com.adelost.ringkit.ui.RingSelectionScreen
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkcore.LinkTarget
import io.agentmux.linkui.product.LinkTargetPresentation

/** Stable addresses identify recipients; a mutable role/model label describes them. */
fun linkRecipientOptions(target: LinkTargetPresentation): List<RingSelectionOption> =
    target.targets.map { recipient ->
        RingSelectionOption(
            id = recipient.id,
            title = recipient.id,
            detail = listOfNotNull(
                recipient.label.takeIf { it.isNotBlank() && it != recipient.id },
                "Unavailable".takeIf { !recipient.acceptsMessages },
                "Replies may be delayed".takeIf { !recipient.available && recipient.acceptsMessages },
            ).joinToString("\n"),
            enabled = recipient.acceptsMessages,
        )
    }

fun linkRecipientRow(target: LinkTargetPresentation, onOpen: () -> Unit): RowSpec {
    val selected = target.targets.firstOrNull { it.id == target.selectedTargetId }
    return RowSpec(
        key = "target.picker",
        title = selected?.let { "TO ${it.id}" } ?: "CHOOSE RECIPIENT",
        sub = when {
            selected == null -> "Who would you like to talk to?"
            !selected.acceptsMessages -> "Unavailable · choose another recipient"
            !selected.available -> "Replies may be delayed · tap to change"
            else -> "Tap to change recipient"
        },
        icon = RingIcons.Target,
        onTap = onOpen,
        actionTiming = CircleActionTiming.IMMEDIATE,
        multiline = true,
    )
}

@Composable
fun LinkRecipientPicker(
    target: LinkTargetPresentation,
    onSelect: (String) -> Unit,
    onBack: () -> Unit,
) {
    BackHandler(onBack = onBack)
    RingSelectionScreen(
    title = "TALK TO",
    options = linkRecipientOptions(target),
    selectedId = target.selectedTargetId,
    icon = RingIcons.Target,
    onSelect = onSelect,
    onBack = onBack,
    emptyLabel = "No recipients connected. Check connection in Settings.",
)
}
