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
    onTap: (() -> Unit)? = null,
    /**
     * Which kind of button this row is, from the product's own declaration
     * ([io.agentmux.linkui.product.generated.GeneratedLinkControlTiming]).
     *
     * A row that says nothing is a touch. That is the safe direction and the one Link already had:
     * until row 225 a host-wide override made every control immediate, so defaulting the other way
     * would put an invisible gate on every row that never names itself. A row with no onTap draws no
     * gesture at all, which is why most callers have nothing to say here.
     */
    timing: CircleActionTiming = CircleActionTiming.IMMEDIATE,
    progress: CircleLabelProgress? = null,
    /** Product-semantic pigment for a row that means something other than the page's ordinary voice. */
    semanticColor: Color? = null,
) {
    RingRow(
        title = title,
        sub = sub,
        icon = icon,
        semanticColor = semanticColor,
        onTap = onTap,
        labelProgress = progress,
        actionTiming = timing,
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
