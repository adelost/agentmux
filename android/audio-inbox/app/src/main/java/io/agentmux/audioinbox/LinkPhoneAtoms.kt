package io.agentmux.audioinbox

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
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
    immediate: Boolean = false,
    progress: CircleLabelProgress? = null,
) {
    RingRow(
        title = title,
        sub = sub,
        icon = icon,
        onTap = onTap,
        labelProgress = progress,
        actionTiming = if (immediate) CircleActionTiming.IMMEDIATE else CircleActionTiming.DELIBERATE,
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
        modifier = phoneRowModifier(),
    )
}

internal fun phoneRowModifier(): Modifier =
    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
