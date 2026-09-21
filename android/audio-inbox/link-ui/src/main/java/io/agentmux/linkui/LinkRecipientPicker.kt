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
import com.adelost.ringkit.ui.ringSelectionRows
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
    val observed = when (model.status) {
        LinkTargetModelStatus.CURRENT -> model.observedModel
            ?.let { targetModelLabel(it, model.observedEffort) }
            ?: "Model unknown"
        LinkTargetModelStatus.STALE -> model.observedModel
            ?.let { "${targetModelLabel(it, model.observedEffort)} · Last seen" }
            ?: "Model unknown"
        LinkTargetModelStatus.UNKNOWN -> "Model unknown"
    }
    val observedMatchesConfigured = model.status == LinkTargetModelStatus.CURRENT &&
        model.observedModel == model.configuredModel &&
        model.observedEffort == model.configuredEffort
    val configured = model.configuredModel
        ?.takeUnless { observedMatchesConfigured }
        ?.let { "Configured · ${targetModelLabel(it, model.configuredEffort)}" }
    return listOfNotNull(observed, configured)
}

/** WHAT: Carries one local window and its exact pane targets. WHY: Keeps grouping separate from transport identity. */
data class LinkRecipientGroup(val windowId: String, val targets: List<LinkTarget>)

/** WHAT: Carries direct targets and grouped windows for one picker frame. WHY: Keeps rendering free of target reshaping. */
data class LinkRecipientMenu(
    val directTargets: List<LinkTarget>,
    val groups: List<LinkRecipientGroup>,
)

private val paneAddress = Regex("^([^:]+):([0-9]+)$")

private fun LinkTarget.windowId(): String? = paneAddress.matchEntire(id)?.groupValues?.get(1)

/** WHAT: Builds direct choices and local window groups from the existing target list. WHY: Keeps IDs exact without another target store. */
fun linkRecipientMenu(target: LinkTargetPresentation, favoriteIds: Set<String>): LinkRecipientMenu {
    val uniqueTargets = target.targets.distinctBy(LinkTarget::id)
    val selected = uniqueTargets.firstOrNull { it.id == target.selectedTargetId }
    val favoriteTargets = uniqueTargets.filter { it.id != selected?.id && it.id in favoriteIds }
    val ungroupedTargets = uniqueTargets.filter {
        it.id != selected?.id && it.id !in favoriteIds && it.windowId() == null
    }
    val directTargets = listOfNotNull(selected) + favoriteTargets + ungroupedTargets
    val directIds = directTargets.mapTo(linkedSetOf(), LinkTarget::id)
    val groups = uniqueTargets
        .filter { it.id !in directIds }
        .groupBy { requireNotNull(it.windowId()) }
        .map { (windowId, recipients) -> LinkRecipientGroup(windowId, recipients) }
    return LinkRecipientMenu(directTargets, groups)
}

private fun linkRecipientDetail(recipient: LinkTarget): String = listOfNotNull(
    *linkTargetModelLines(recipient).toTypedArray(),
    "Unavailable".takeIf { !recipient.acceptsMessages },
    "Replies may be delayed".takeIf { !recipient.available && recipient.acceptsMessages },
).joinToString("\n")

/** WHAT: Builds selectable recipient rows. WHY: Keeps model qualifiers attached to stable recipient addresses. */
fun linkRecipientOptions(recipients: List<LinkTarget>): List<RingSelectionOption> =
    recipients.distinctBy(LinkTarget::id).map { recipient ->
        RingSelectionOption(
            id = recipient.id,
            title = recipient.id,
            detail = linkRecipientDetail(recipient),
            enabled = recipient.acceptsMessages,
            accent = linkSenderAccent(recipient.id),
        )
    }

/** WHAT: Builds options for one complete target presentation. WHY: Keeps legacy callers on the same row formatter. */
fun linkRecipientOptions(target: LinkTargetPresentation): List<RingSelectionOption> =
    linkRecipientOptions(target.targets)

/** WHAT: Builds the selected-target row for HOME. WHY: Keeps HOME metadata identical to the picker. */
fun linkRecipientRow(target: LinkTargetPresentation, onOpen: () -> Unit): RowSpec {
    val selected = target.targets.firstOrNull { it.id == target.selectedTargetId }
    return RowSpec(
        key = "target.picker",
        title = selected?.let { "TO ${it.id}" } ?: "CHOOSE RECIPIENT",
        sub = selected?.let(::linkRecipientDetail) ?: "Who would you like to talk to?",
        icon = RingIcons.Target,
        accent = selected?.let { linkSenderAccent(it.id) } ?: CircleAccent.NEUTRAL,
        onTap = onOpen,
        actionTiming = GeneratedLinkControlTiming.HOME_RECIPIENT,
        multiline = true,
    )
}

/** WHAT: Builds direct targets, window groups and favorite editing. WHY: Keeps selection on one stable target ID. */
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
    var openWindow by remember { mutableStateOf<String?>(null) }
    val menu = remember(target.targets, target.selectedTargetId, favorites) {
        linkRecipientMenu(target, favorites)
    }
    val back = {
        when {
            editing -> editing = false
            openWindow != null -> openWindow = null
            else -> onBack()
        }
    }
    BackHandler(onBack = back)
    if (editing) {
        val rows = remember { MutableStateFlow(emptyList<RowSpec>()) }
        val navigator = remember { RingNavigator(RingScreen.Rows("FAVORITES", rows)) }
        LaunchedEffect(target.targets, favorites) {
            rows.value = target.targets.distinctBy(LinkTarget::id).map { recipient ->
                val favorite = recipient.id in favorites
                RowSpec(recipient.id, recipient.id, listOf(
                    if (favorite) "REMOVE FAVORITE" else "ADD FAVORITE",
                    *linkTargetModelLines(recipient).toTypedArray(),
                ).joinToString("\n"),
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
    menu.groups.firstOrNull { it.windowId == openWindow }?.let { group ->
        RingSelectionScreen(
            title = group.windowId,
            options = linkRecipientOptions(group.targets),
            selectedId = target.selectedTargetId,
            icon = RingIcons.Target,
            onSelect = onSelect,
            onBack = back,
            emptyLabel = "No panels",
        )
        return
    }

    val rows = remember { MutableStateFlow(emptyList<RowSpec>()) }
    val navigator = remember { RingNavigator(RingScreen.Rows("TALK TO", rows)) }
    LaunchedEffect(menu, target.selectedTargetId, favorites) {
        val directRows = ringSelectionRows(
            options = linkRecipientOptions(menu.directTargets).map {
                if (it.id in favorites) it.copy(icon = RingIcons.Star) else it
            },
            selectedId = target.selectedTargetId,
            icon = RingIcons.Target,
            onSelect = onSelect,
        )
        val groupRows = menu.groups.map { group ->
            RowSpec(
                key = "recipient.window:${group.windowId}",
                title = group.windowId,
                sub = if (group.targets.size == 1) "1 PANEL" else "${group.targets.size} PANELS",
                icon = RingIcons.Grid,
                onTap = { openWindow = group.windowId },
                actionTiming = GeneratedLinkControlTiming.RECIPIENTS_SELECT,
            )
        }
        rows.value = if (target.targets.isEmpty()) {
            listOf(RowSpec("empty", "No connected windows", "", RingIcons.Target))
        } else {
            directRows + groupRows + RowSpec(
                key = "favorites",
                title = "FAVORITES",
                sub = "",
                icon = RingIcons.Star,
                onTap = { editing = true },
                actionTiming = GeneratedLinkControlTiming.RECIPIENTS_FAVORITES,
            )
        }
    }
    RingRoundBackHost(back) { RenderRingScreen(navigator, onExit = back, backLabel = "Back") }
}
