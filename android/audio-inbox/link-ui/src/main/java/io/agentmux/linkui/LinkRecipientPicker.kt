package io.agentmux.linkui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import android.content.Context
import androidx.activity.compose.BackHandler
import com.adelost.designkit.ui.CircleAccent
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
import io.agentmux.linkcore.LinkTargetModelStatus
import io.agentmux.linkui.product.LinkTargetPresentation
import io.agentmux.linkui.product.generated.GeneratedLinkControlTiming

private fun targetModelLabel(model: String, effort: String?): String =
    listOfNotNull(model, effort?.takeIf(String::isNotBlank)).joinToString(" · ")

/** WHAT: Formats qualified model evidence. WHY: Separates observed runtime truth from configured intent. */
fun linkTargetModelLines(target: LinkTarget): List<String> {
    val model = target.model ?: return emptyList()
    val observed = model.observedModel?.let {
        "${targetModelLabel(it, model.observedEffort)} · ${when (model.status) {
            LinkTargetModelStatus.CURRENT -> "OBSERVED"
            LinkTargetModelStatus.STALE -> "STALE"
            LinkTargetModelStatus.UNKNOWN -> "UNKNOWN"
        }}"
    } ?: "MODEL UNKNOWN"
    val configured = model.configuredModel?.let {
        "${targetModelLabel(it, model.configuredEffort)} · CONFIGURED"
    }
    return listOfNotNull(observed, configured)
}

/** WHAT: Builds selectable recipient rows. WHY: Keeps model qualifiers attached to stable recipient addresses. */
fun linkRecipientOptions(target: LinkTargetPresentation): List<RingSelectionOption> =
    target.targets.map { recipient ->
        RingSelectionOption(
            id = recipient.id,
            title = recipient.id,
            detail = listOfNotNull(
                // The check icon alone did not say which row is the current recipient.
                "TALKING TO NOW".takeIf { recipient.id == target.selectedTargetId },
                recipient.label.takeIf { it.isNotBlank() && it != recipient.id },
                *linkTargetModelLines(recipient).toTypedArray(),
                "Unavailable".takeIf { !recipient.acceptsMessages },
                "Replies may be delayed".takeIf { !recipient.available && recipient.acceptsMessages },
            ).joinToString("\n"),
            enabled = recipient.acceptsMessages,
            accent = linkSenderAccent(recipient.id),
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
        accent = selected?.let { linkSenderAccent(it.id) } ?: CircleAccent.NEUTRAL,
        onTap = onOpen,
        actionTiming = GeneratedLinkControlTiming.HOME_RECIPIENT,
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
                val favorite = recipient.id in favorites
                RowSpec(recipient.id, recipient.id,
                    listOf(if (favorite) "FAVORITE · tap to remove" else "Tap to add to favorites", recipient.label)
                        .filter { it.isNotBlank() }.joinToString("\n"),
                    icon = if (favorite) RingIcons.Star else RingIcons.Target, accent = linkSenderAccent(recipient.id),
                    multiline = true, actionTiming = GeneratedLinkControlTiming.RECIPIENTS_SELECT,
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
        onTap = { editing = true }, actionTiming = GeneratedLinkControlTiming.RECIPIENTS_FAVORITES)),
)
}
