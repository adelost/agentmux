package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedProductInputPortId
import io.agentmux.linkui.product.generated.GeneratedProductOutputPortId
import io.agentmux.linkui.product.generated.GeneratedProductPortId

/**
 * Closed presentation quality shared by product UI and the DEV inspector.
 *
 * Public because [ProductPortInspection] crosses the link-ui module boundary
 * to the DEV host screen; the port machinery below stays module-internal.
 */
enum class ProductPortQuality {
    LIVE,
    STALE,
    UNAVAILABLE,
    UNBOUND,
}

internal abstract class ProductOutputPort<T : Any> protected constructor(
    final override val id: GeneratedProductOutputPortId,
) : LinkNativeOutputPortBinding

internal abstract class ProductInputPort<T : Any, R : Any> protected constructor(
    final override val id: GeneratedProductInputPortId,
) : LinkNativeInputPortBinding

internal abstract class ProductDataInput<T : Any> protected constructor(
    final override val id: GeneratedProductInputPortId,
) : LinkNativeInputPortBinding

internal abstract class ProductComponentInput<T : Any> protected constructor(
    internal val id: GeneratedProductInputPortId,
)

internal abstract class ProductComponentEvent<T : Any, R : Any> protected constructor(
    internal val id: GeneratedProductOutputPortId,
)

internal sealed interface LinkNativeInputPortBinding {
    val id: GeneratedProductInputPortId
}

internal sealed interface LinkNativeOutputPortBinding {
    val id: GeneratedProductOutputPortId
}

internal class ProductComponentEventEmitter<T : Any, R : Any> internal constructor(
    private val runtime: LinkProductPortRuntime,
    private val port: ProductComponentEvent<T, R>,
) {
    fun emit(event: T): R = runtime.emit(port, event)
}

internal data class ProductPortValue<out T>(
    val value: T?,
    val observedAtEpochMs: Long?,
    val quality: ProductPortQuality,
)

/**
 * One inspector row over a generated port. Link declares no demand ports, so
 * [demandOwners] stays in the shape but is always empty.
 *
 * The generated owner/direction/boundary enums are module-internal, so this
 * public row carries their names; the DEV host module only ever renders them.
 */
data class ProductPortInspection(
    val id: String,
    val ownerKind: String,
    val ownerId: String,
    val direction: String,
    val boundary: String,
    val contractRef: String,
    val required: Boolean,
    val value: String?,
    val observedAtEpochMs: Long?,
    val ageMs: Long?,
    val quality: ProductPortQuality,
    val demandOwners: Set<String>,
    val bindings: Set<String>,
)
