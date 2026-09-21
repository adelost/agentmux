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
    content: @Composable (GeneratedLinkHomeComponent) -> Unit,
) {
    val (rail, body) = tree.orderedMounts.partition { it.region == GeneratedLinkHomeRegion.RAIL }
    if (rail.isEmpty()) {
        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
            groupedHomeComponents(body.map { it.component }, content)
        }
    } else {
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(0.30f), horizontalAlignment = Alignment.CenterHorizontally) {
                groupedHomeComponents(rail.map { it.component }, content)
            }
            Column(Modifier.weight(0.70f)) {
                groupedHomeComponents(body.map { it.component }, content)
            }
        }
    }
}

/** WHAT: Groups the two declared audio controls on one Phone quick-control row. WHY: Keeps conversation height primary. */
@Composable
private fun ColumnScope.groupedHomeComponents(
    components: List<GeneratedLinkHomeComponent>,
    content: @Composable (GeneratedLinkHomeComponent) -> Unit,
) {
    var index = 0
    while (index < components.size) {
        val component = components[index]
        val next = components.getOrNull(index + 1)
        if (
            component == GeneratedLinkHomeComponent.PREFERENCES_TOGGLES &&
            next == GeneratedLinkHomeComponent.WAKE_TOGGLE
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly,
                verticalAlignment = Alignment.Top,
            ) {
                Box(Modifier.weight(1f), contentAlignment = Alignment.TopCenter) { content(component) }
                Box(Modifier.weight(1f), contentAlignment = Alignment.TopCenter) { content(next) }
            }
            index += 2
        } else {
            content(component)
            index += 1
        }
    }
}
