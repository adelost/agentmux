package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedLinkNativeLegoCatalog
import io.agentmux.linkui.product.generated.GeneratedProductPort
import io.agentmux.linkui.product.generated.GeneratedProductPortBinding
import io.agentmux.linkui.product.generated.GeneratedProductPortBindingKind
import io.agentmux.linkui.product.generated.GeneratedProductPortDirection
import io.agentmux.linkui.product.generated.GeneratedProductPortId
import io.agentmux.linkui.product.generated.GeneratedProductPortOwnerKind
import io.agentmux.linkui.product.generated.GeneratedProductPortPurpose

/** Validated view of the one generated graph used by both runtime and inspector. */
internal class ProductPortGraph {
    val declarations: Map<GeneratedProductPortId, GeneratedProductPort> = buildMap {
        GeneratedLinkNativeLegoCatalog.ports.forEach { port ->
            check(put(port.id, port) == null) {
                "Generated product registry declares ${port.id.value} more than once"
            }
        }
    }
    val bindings: List<GeneratedProductPortBinding> = GeneratedLinkNativeLegoCatalog.portBindings
    val bindingsByInput: Map<GeneratedProductPortId, GeneratedProductPortBinding> = buildBindingsByInput()

    fun requirePort(
        id: GeneratedProductPortId,
        direction: GeneratedProductPortDirection,
    ): GeneratedProductPort {
        val port = requireNotNull(declarations[id]) { "Unknown generated product port ${id.value}" }
        require(port.direction == direction) {
            "Product port ${id.value} is ${port.direction}, not $direction"
        }
        return port
    }

    fun requireDataBinding(port: ProductDataInput<*>): GeneratedProductPortBinding {
        val declaration = requirePort(port.id, GeneratedProductPortDirection.INPUT)
        check(declaration.purpose != GeneratedProductPortPurpose.DEMAND) {
            "Product data input ${port.id.value} is a demand port"
        }
        return requireNotNull(bindingsByInput[port.id]).also { binding ->
            check(binding.kind != GeneratedProductPortBindingKind.COMPONENT_EVENT) {
                "Product data input ${port.id.value} is a component event"
            }
        }
    }

    fun requireComponentDataBinding(port: ProductComponentInput<*>): GeneratedProductPortBinding {
        val declaration = requirePort(port.id, GeneratedProductPortDirection.INPUT)
        check(declaration.ownerKind == GeneratedProductPortOwnerKind.COMPONENT) {
            "Product component input ${port.id.value} is owned by ${declaration.ownerKind}"
        }
        return requireNotNull(bindingsByInput[port.id]).also { binding ->
            check(binding.kind == GeneratedProductPortBindingKind.COMPONENT_INPUT) {
                "Product component input ${port.id.value} is bound as ${binding.kind}"
            }
        }
    }

    fun requireComponentEventBinding(port: ProductComponentEvent<*, *>): GeneratedProductPortBinding {
        val declaration = requirePort(port.id, GeneratedProductPortDirection.OUTPUT)
        check(declaration.ownerKind == GeneratedProductPortOwnerKind.COMPONENT) {
            "Product component event ${port.id.value} is owned by ${declaration.ownerKind}"
        }
        return bindings.singleOrNull {
            it.kind == GeneratedProductPortBindingKind.COMPONENT_EVENT && it.from == port.id
        } ?: error("Product component event ${port.id.value} has no single generated target")
    }

    private fun buildBindingsByInput(): Map<GeneratedProductPortId, GeneratedProductPortBinding> = buildMap {
        bindings.forEach { binding ->
            val output = requireNotNull(declarations[binding.from]) {
                "Generated binding names unknown output ${binding.from.value}"
            }
            val input = requireNotNull(declarations[binding.to]) {
                "Generated binding names unknown input ${binding.to.value}"
            }
            check(output.direction == GeneratedProductPortDirection.OUTPUT) {
                "Generated binding source ${binding.from.value} is not an output"
            }
            check(input.direction == GeneratedProductPortDirection.INPUT) {
                "Generated binding target ${binding.to.value} is not an input"
            }
            check(put(binding.to, binding) == null) {
                "Generated input ${binding.to.value} has more than one upstream output"
            }
        }
        val orphanInputs = declarations.values.filter { port ->
            port.direction == GeneratedProductPortDirection.INPUT &&
                port.purpose == GeneratedProductPortPurpose.DATA &&
                port.id !in keys
        }
        check(orphanInputs.isEmpty()) {
            "Generated inputs have no upstream output: ${orphanInputs.joinToString { it.id.value }}"
        }
    }
}
