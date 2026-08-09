package io.agentmux.linkui

import com.adelost.designkit.ui.RingIcons
import com.adelost.ringkit.data.Health
import com.adelost.ringkit.data.SourceId
import com.adelost.ringkit.ui.RingScreen
import com.adelost.ringkit.ui.RowSpec
import io.agentmux.linkui.product.ProductPortInspection
import io.agentmux.linkui.product.ProductPortQuality
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

/** DEV inspector rendered from the exact generated ProductSpec port runtime. */
fun linkProductPortRows(
    ports: Flow<List<ProductPortInspection>>,
    push: (RingScreen) -> Unit,
) = RingScreen.Rows(
    title = "PRODUCT PORTS",
    items = ports.map { snapshots ->
        snapshots.map { port ->
            RowSpec(
                key = port.id,
                title = port.id.uppercase(),
                sub = portListSummary(port),
                icon = portIcon(port),
                onTap = { push(linkProductPortDetail(ports, port.id)) },
            )
        }
    },
)

private fun linkProductPortDetail(
    ports: Flow<List<ProductPortInspection>>,
    portId: String,
) = RingScreen.Detail(
    title = portId.substringAfterLast('.').uppercase(),
    icon = RingIcons.Layers,
    sourceId = SourceId("product-port-$portId"),
    hero = ports.map { rows -> rows.requirePort(portId).quality.name },
    sub = ports.map { rows ->
        rows.requirePort(portId).let { port ->
            buildList {
                add(port.contractRef.uppercase())
                port.value?.let { add(it) }
                if (port.bindings.isNotEmpty()) add("${port.bindings.size} BINDING")
            }.joinToString(" · ")
        }
    },
    freshness = ports.map { rows ->
        rows.requirePort(portId).let { port ->
            port.ageMs?.let(::formatPortAge) ?: "NOT OBSERVED"
        }
    },
    health = ports.map { rows -> portHealth(rows.requirePort(portId)) },
    progress = ports.map { null },
    actions = emptyList(),
)

internal fun portFactRows(port: ProductPortInspection): List<RowSpec> = buildList {
    add(RowSpec("owner", "OWNER", "${port.ownerKind} · ${port.ownerId}", RingIcons.Layers))
    add(RowSpec("direction", "PORT", "${port.direction} · ${port.boundary}", RingIcons.Arrow))
    add(RowSpec("contract", "CONTRACT", port.contractRef, RingIcons.Book))
    add(RowSpec("quality", "QUALITY", port.quality.name, RingIcons.Gauge))
    add(RowSpec("observed", "OBSERVED", port.ageMs?.let(::formatPortAge) ?: "NEVER", RingIcons.Refresh))
    add(
        RowSpec(
            "bindings",
            "GRAPH BINDINGS",
            port.bindings.sorted().joinToString().ifEmpty { "NONE" },
            RingIcons.Link,
        ),
    )
    port.value?.let { add(RowSpec("value", "LATEST SNAPSHOT", it, RingIcons.Book)) }
}

internal fun portListSummary(port: ProductPortInspection): String = buildList {
    add(port.quality.name)
    port.ageMs?.let { add(formatPortAge(it)) }
}.joinToString(" · ")

internal fun portHealth(port: ProductPortInspection): Health = when (port.quality) {
    ProductPortQuality.LIVE -> Health.FRESH
    ProductPortQuality.STALE, ProductPortQuality.UNAVAILABLE -> Health.AGING
    ProductPortQuality.UNBOUND -> Health.BROKEN
}

private fun List<ProductPortInspection>.requirePort(id: String): ProductPortInspection =
    singleOrNull { it.id == id } ?: error("Generated product port disappeared: $id")

private fun portIcon(port: ProductPortInspection) = when (port.boundary) {
    "UI_EVENT" -> RingIcons.Arrow
    "PRESENTATION" -> RingIcons.Gauge
    else -> RingIcons.Layers
}

private fun formatPortAge(ageMs: Long): String = when {
    ageMs < 1_000L -> "NOW"
    ageMs < 60_000L -> "${ageMs / 1_000L} SEC"
    else -> "${ageMs / 60_000L} MIN"
}
