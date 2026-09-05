package io.agentmux.linkui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import android.content.Context
import androidx.activity.compose.BackHandler
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.ui.RingSelectionOption
import com.adelost.ringkit.ui.RingSelectionScreen
import com.adelost.ringkit.ui.RowSpec
import com.adelost.ringkit.ui.RingNavigator
import com.adelost.ringkit.ui.RingScreen
import com.adelost.ringkit.ui.RenderRingScreen
import com.adelost.ringkit.ui.RingRoundBackHost
import kotlinx.coroutines.flow.MutableStateFlow
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
            else -> ""
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
    val context = LocalContext.current
    val preferences = remember(context) {
        context.getSharedPreferences("link_recipient_favorites", Context.MODE_PRIVATE)
    }
    var favorites by remember { mutableStateOf(preferences.getStringSet("ids", emptySet())!!.toSet()) }
    var editing by remember { mutableStateOf(false) }
    val back = { if (editing) editing = false else onBack() }
    BackHandler(onBack = back)
    if (editing) {
        val rows = remember { MutableStateFlow(emptyList<RowSpec>()) }
        val navigator = remember { RingNavigator(RingScreen.Rows("FAVORITES", rows)) }
        LaunchedEffect(target.targets, favorites) {
            rows.value = target.targets.map { recipient ->
                RowSpec(recipient.id, recipient.id, recipient.label,
                    icon = if (recipient.id in favorites) RingIcons.Check else RingIcons.Target,
                    multiline = true, actionTiming = CircleActionTiming.IMMEDIATE,
                    onTap = {
                        favorites = if (recipient.id in favorites) favorites - recipient.id else favorites + recipient.id
                        preferences.edit().putStringSet("ids", favorites).apply()
                    })
            }
        }
        RingRoundBackHost(back) { RenderRingScreen(navigator, onExit = back, backLabel = "Back") }
        return
    }
    RingSelectionScreen(
    title = "TALK TO",
    options = linkRecipientOptions(target).sortedBy { it.id !in favorites }
        .map { if (it.id in favorites) it.copy(icon = RingIcons.Star) else it },
    selectedId = target.selectedTargetId,
    icon = RingIcons.Target,
    onSelect = onSelect,
    onBack = onBack,
    emptyLabel = "No connected windows",
    extraRows = listOf(RowSpec("favorites", "FAVORITES", "", RingIcons.Star,
        onTap = { editing = true }, actionTiming = CircleActionTiming.IMMEDIATE)),
)
}
