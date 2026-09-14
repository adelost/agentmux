package io.agentmux.linkui.product

import com.adelost.ringkit.ports.CirclePortInspection
import com.adelost.ringkit.ports.CirclePortQuality
import com.adelost.ringkit.ports.CirclePortRole
import io.agentmux.linkui.product.generated.GeneratedProductPort
import io.agentmux.linkui.product.generated.GeneratedProductPortBoundary
import io.agentmux.linkui.product.generated.GeneratedProductPortBindingKind
import io.agentmux.linkui.product.generated.GeneratedProductPortDirection
import io.agentmux.linkui.product.generated.GeneratedProductPortId
import io.agentmux.linkui.product.generated.GeneratedProductPortPurpose
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow

/** Inspector projection over the exact live native store and generated topology. */
internal class ProductPortInspector(
    private val graph: ProductPortGraph,
    private val currentValues: () -> Map<GeneratedProductPortId, ProductPortValue<Any?>>,
    private val demandOwners: () -> Map<String, Set<String>>,
    private val wallClockMs: () -> Long,
) {
    fun flow(refreshMs: Long): Flow<List<CirclePortInspection>> = flow {
        while (true) {
            emit(inspections())
            delay(refreshMs)
        }
    }

    fun inspections(nowMs: Long = wallClockMs()): List<CirclePortInspection> {
        val current = currentValues()
        val owners = demandOwners()
        return graph.declarations.values.map { port ->
            val value = inspectionValue(port, current, owners)
            CirclePortInspection(
                id = port.id.value,
                ownerId = port.ownerId,
                role = portRole(port),
                contractRef = port.contractRef,
                direction = port.direction.name,
                boundary = port.boundary.name,
                required = port.required,
                quality = CirclePortQuality.valueOf(value.quality.name),
                value = value.value?.toString(),
                ageMs = value.observedAtEpochMs?.let { (nowMs - it).coerceAtLeast(0L) },
                demandOwners = if (port.purpose == GeneratedProductPortPurpose.DEMAND) {
                    owners[port.ownerId].orEmpty()
                } else {
                    emptySet()
                },
                bindings = graph.bindings.filter { it.from == port.id || it.to == port.id }
                    .mapTo(linkedSetOf()) { "${it.kind}:${it.from.value}->${it.to.value}" },
            )
        }
    }

    private fun portRole(port: GeneratedProductPort): CirclePortRole = when {
        port.purpose == GeneratedProductPortPurpose.DEMAND -> CirclePortRole.DEMAND
        port.boundary == GeneratedProductPortBoundary.UI_EVENT -> CirclePortRole.COMMAND
        else -> CirclePortRole.DATA
    }

    private fun inspectionValue(
        port: GeneratedProductPort,
        current: Map<GeneratedProductPortId, ProductPortValue<Any?>>,
        owners: Map<String, Set<String>>,
    ): ProductPortValue<Any?> {
        if (port.direction == GeneratedProductPortDirection.OUTPUT) {
            return requireNotNull(current[port.id])
        }
        if (port.purpose == GeneratedProductPortPurpose.DEMAND) {
            val status = if (owners[port.ownerId].isNullOrEmpty()) "INACTIVE" else "ACTIVE"
            return ProductPortValue(status, null, ProductPortQuality.LIVE)
        }
        val binding = graph.bindingsByInput[port.id]
            ?: return ProductPortValue(null, null, ProductPortQuality.UNBOUND)
        return if (binding.kind == GeneratedProductPortBindingKind.COMPONENT_EVENT) {
            requireNotNull(current[port.id])
        } else {
            requireNotNull(current[binding.from])
        }
    }
}
