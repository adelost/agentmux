package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedProductInputPortId
import io.agentmux.linkui.product.generated.GeneratedProductOutputPortId
import io.agentmux.linkui.product.generated.GeneratedProductPortId

/**
 * Closed presentation quality of the native port store; the DEV ports view maps it
 * onto CircleKit's CirclePortQuality. The port machinery below stays module-internal.
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

