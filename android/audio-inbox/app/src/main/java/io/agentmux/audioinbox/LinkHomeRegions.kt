package io.agentmux.audioinbox

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import io.agentmux.linkui.product.generated.GeneratedLinkHomeComponent
import io.agentmux.linkui.product.generated.GeneratedLinkHomeRegion
import io.agentmux.linkui.product.generated.GeneratedLinkHomeTree

/** Only layout differs: render each declared mount once, with the same state. */
@Composable
internal fun LinkHomeRegions(
    tree: GeneratedLinkHomeTree,
    content: @Composable ColumnScope.(GeneratedLinkHomeComponent) -> Unit,
) {
    val (rail, body) = tree.orderedMounts.partition { it.region == GeneratedLinkHomeRegion.RAIL }
    if (rail.isEmpty()) {
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
            body.forEach { content(it.component) }
        }
    } else {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(0.30f), horizontalAlignment = Alignment.CenterHorizontally) {
                rail.forEach { content(it.component) }
            }
            Column(Modifier.weight(0.70f)) { body.forEach { content(it.component) } }
        }
    }
}
