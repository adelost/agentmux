package io.agentmux.audioinbox

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.adelost.designkit.ui.CircleActionTiming
import com.adelost.designkit.ui.CircleLabelProgress
import com.adelost.ringkit.ui.RingRow
import com.adelost.ringkit.ui.RowSpec

/** Link-specific copy projected through the one shared CircleKit phone row. */
@Composable
internal fun PhoneRow(
    title: String,
    sub: String,
    icon: ImageVector,
    /** What happens when this row is pressed, and which kind of button that makes it. */
    press: LinkPress? = null,
    progress: CircleLabelProgress? = null,
    /** Product-semantic pigment for a row that means something other than the page's ordinary voice. */
    semanticColor: Color? = null,
) {
    RingRow(
        title = title,
        sub = sub,
        icon = icon,
        semanticColor = semanticColor,
        onTap = press?.onTap,
        labelProgress = progress,
        actionTiming = press?.timing ?: CircleActionTiming.IMMEDIATE,
        modifier = phoneRowModifier(),
    )
}

/** Phone layout adapter for canonical data-driven CircleKit rows. */
@Composable
internal fun PhoneRow(row: RowSpec) {
    RingRow(
        title = row.title,
        sub = row.sub,
        icon = row.icon,
        accent = row.accent,
        semanticColor = row.semanticColor,
        onTap = row.onTap,
        labelProgress = row.labelProgress,
        holdToConfirm = row.holdToConfirm,
        holdMs = row.holdMs,
        actionTiming = row.actionTiming,
        hint = row.hint,
        multiline = row.multiline,
        modifier = phoneRowModifier(),
    )
}

internal fun phoneRowModifier(): Modifier =
    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)

/**
 * A press and the kind of button it makes, which travel together because they are one decision.
 *
 * Row 225, lsrc:0 on #393: a defaulted timing beside an optional onTap is the same hand-over the
 * whole row is about. A row could then be pressable while saying nothing about its kind, and the
 * next person to add a row that deletes something would get a touch for free. Neither field has a
 * default, so a row that can be pressed cannot omit its kind, and a row that only reads says so by
 * having no press at all.
 *
 * The timing comes from the product's own declaration,
 * [io.agentmux.linkui.product.generated.GeneratedLinkControlTiming], never from a call site.
 */
internal data class LinkPress(val timing: CircleActionTiming, val onTap: () -> Unit)
