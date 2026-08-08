package io.agentmux.linkui.product

import io.agentmux.linkui.product.generated.GeneratedProductPort
import io.agentmux.linkui.product.generated.GeneratedProductPortBinding
import io.agentmux.linkui.product.generated.GeneratedProductPortBindingKind
import io.agentmux.linkui.product.generated.GeneratedProductPortDirection
import io.agentmux.linkui.product.generated.GeneratedProductPortId
import io.agentmux.linkui.product.generated.GeneratedProductPortOwnerKind
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Runtime half of the generated product graph. Port identity and topology are
 * generated; native code may only attach a typed value or event sink to an
 * existing ID. The inspector reads this exact store, never a second catalog.
 *
 * Link declares ten lifetime services and no demand ports, so there is no
 * demand-owner provider here: the inspector's demandOwners stay empty.
 */
internal class LinkProductPortRuntime(
    private val processScope: CoroutineScope,
    private val wallClockMs: () -> Long = System::currentTimeMillis,
) {
    private val graph = ProductPortGraph()
    private val declarations = graph.declarations
    private val bindingsByInput = graph.bindingsByInput
    private val outputUpdates = declarations.values
        .filter { it.direction == GeneratedProductPortDirection.OUTPUT }
        .associate { it.id to MutableSharedFlow<Any>(replay = 1, extraBufferCapacity = 64) }
    private val values = MutableStateFlow(
        declarations.keys.associateWith {
            ProductPortValue<Any?>(null, null, ProductPortQuality.UNBOUND)
        },
    )
    private data class InputRegistration(val token: Any, val sink: (Any?) -> Any)

    private val inputSinks = mutableMapOf<GeneratedProductPortId, InputRegistration>()
    private val observedOutputs = mutableMapOf<GeneratedProductPortId, Any>()
    private val consumedDataInputs = mutableMapOf<GeneratedProductPortId, Any>()
    private val consumedComponentInputs = mutableMapOf<GeneratedProductPortId, Any>()
    private val componentEventEmitters = mutableMapOf<GeneratedProductPortId, Any>()
    private val connectedStates = mutableMapOf<GeneratedProductPortId, StateFlow<Any>>()
    private val inspector = ProductPortInspector(graph, { values.value }, { emptyMap() }, wallClockMs)

    fun <T : Any> observe(
        port: ProductOutputPort<T>,
        source: Flow<T>,
        ownerScope: CoroutineScope = processScope,
        quality: (T) -> ProductPortQuality = { ProductPortQuality.LIVE },
    ): AutoCloseable {
        requirePort(port.id, GeneratedProductPortDirection.OUTPUT)
        val token = Any()
        synchronized(this) {
            check(observedOutputs.putIfAbsent(port.id, token) == null) {
                "Product port ${port.id.value} already has a native output binding"
            }
        }
        markBound(port.id)
        val state = source as? StateFlow<T>
        state?.let {
            publish(port.id, it.value, quality(it.value))
            check(outputUpdates.getValue(port.id).tryEmit(it.value))
        }
        val job = ownerScope.launch {
            val updates = if (state == null) source else state.drop(1)
            updates.collect { next ->
                publish(port.id, next, quality(next))
                outputUpdates.getValue(port.id).emit(next)
            }
        }
        job.invokeOnCompletion { removeOutput(port.id, token) }
        return AutoCloseable {
            job.cancel()
            removeOutput(port.id, token)
        }
    }

    /**
     * Reads a service input through its generated upstream edge. Native
     * projections cannot subscribe to the producer a second time or bypass
     * ProductSpec wiring.
     */
    @Suppress("UNCHECKED_CAST")
    fun <T : Any> connected(port: ProductDataInput<T>): StateFlow<T> {
        return connectedState(port) as StateFlow<T>
    }

    /** A state-valued data input, active only for [ownerScope]. */
    fun <T : Any> connected(
        port: ProductDataInput<T>,
        ownerScope: CoroutineScope,
    ): StateFlow<T> {
        val state = connectedState(port)
        val token = registerDataInput(port.id)
        val owner = requireNotNull(ownerScope.coroutineContext[Job]) {
            "Product data input owner ${port.id.value} has no lifecycle Job"
        }
        owner.invokeOnCompletion { removeDataInput(port.id, token) }
        return state
    }

    /** The component reads the exact upstream projection bound by ProductSpec. */
    @Suppress("UNCHECKED_CAST")
    fun <T : Any> connected(
        port: ProductComponentInput<T>,
        ownerScope: CoroutineScope,
    ): StateFlow<T> {
        val binding = requireComponentDataBinding(port)
        val state = connectedState(binding, port.id) as StateFlow<T>
        val token = registerComponentInput(port.id)
        val owner = requireNotNull(ownerScope.coroutineContext[Job]) {
            "Product component input owner ${port.id.value} has no lifecycle Job"
        }
        owner.invokeOnCompletion { removeComponentInput(port.id, token) }
        return state
    }

    /** Lifecycle-owned native consumer of the one generated upstream value. */
    @Suppress("UNCHECKED_CAST")
    fun <T : Any> connected(
        port: ProductDataInput<T>,
        ownerScope: CoroutineScope,
        sink: (T) -> Unit,
    ): AutoCloseable {
        val binding = requireDataBinding(port)
        val token = registerDataInput(port.id)
        val job = ownerScope.launch {
            outputUpdates.getValue(binding.from).mapNotNull { it as T? }
                .distinctUntilChanged()
                .collect(sink)
        }
        job.invokeOnCompletion { removeDataInput(port.id, token) }
        return AutoCloseable {
            job.cancel()
            removeDataInput(port.id, token)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun <T : Any> connectedState(port: ProductDataInput<T>): StateFlow<T> {
        val binding = requireDataBinding(port)
        return connectedState(binding, port.id) as StateFlow<T>
    }

    @Suppress("UNCHECKED_CAST")
    private fun connectedState(
        binding: GeneratedProductPortBinding,
        inputId: GeneratedProductPortId,
    ): StateFlow<Any> {
        synchronized(this) {
            connectedStates[inputId]?.let { return it }
            val initial = requireNotNull(values.value.getValue(binding.from).value) {
                "Upstream product output ${binding.from.value} is not mounted before ${inputId.value}"
            }
            return values.mapNotNull { snapshot ->
                snapshot.getValue(binding.from).value
            }.distinctUntilChanged().stateIn(processScope, SharingStarted.Eagerly, initial).also {
                connectedStates[inputId] = it
            }
        }
    }

    private fun requireDataBinding(port: ProductDataInput<*>): GeneratedProductPortBinding {
        return graph.requireDataBinding(port)
    }

    private fun requireComponentDataBinding(port: ProductComponentInput<*>): GeneratedProductPortBinding {
        return graph.requireComponentDataBinding(port)
    }

    fun <T : Any, R : Any> bindInput(
        port: ProductInputPort<T, R>,
        sink: (T) -> R,
    ): AutoCloseable = bindInput(port, processScope, sink)

    fun <T : Any, R : Any> bindInput(
        port: ProductInputPort<T, R>,
        ownerScope: CoroutineScope,
        sink: (T) -> R,
    ): AutoCloseable {
        requirePort(port.id, GeneratedProductPortDirection.INPUT)
        val token = Any()
        val registration = InputRegistration(token) { value -> @Suppress("UNCHECKED_CAST") sink(value as T) }
        synchronized(this) {
            check(inputSinks.putIfAbsent(port.id, registration) == null) {
                "Product port ${port.id.value} already has a native input binding"
            }
        }
        markBound(port.id)
        val owner = requireNotNull(ownerScope.coroutineContext[Job]) {
            "Product input owner ${port.id.value} has no lifecycle Job"
        }
        owner.invokeOnCompletion { removeInput(port.id, token) }
        return AutoCloseable { removeInput(port.id, token) }
    }

    /** Lifecycle-owned native emitter for one declared component event source. */
    fun <T : Any, R : Any> componentEvent(
        port: ProductComponentEvent<T, R>,
        ownerScope: CoroutineScope,
    ): ProductComponentEventEmitter<T, R> {
        requireComponentEventBinding(port)
        val token = registerComponentEvent(port.id)
        val owner = requireNotNull(ownerScope.coroutineContext[Job]) {
            "Product component event owner ${port.id.value} has no lifecycle Job"
        }
        owner.invokeOnCompletion { removeComponentEvent(port.id, token) }
        return ProductComponentEventEmitter(this, port)
    }

    @Suppress("UNCHECKED_CAST")
    fun <T : Any, R : Any> send(port: ProductInputPort<T, R>, event: T): R {
        val binding = requireNotNull(bindingsByInput[port.id])
        check(binding.kind != GeneratedProductPortBindingKind.COMPONENT_EVENT) {
            "Component event ${binding.from.value} must emit through its typed source handle"
        }
        val result = requireNotNull(inputSinks[port.id]) {
            "Missing native input binding for required port ${port.id.value}"
        }.sink(event)
        publishConnected(binding, event, ProductPortQuality.LIVE)
        return result as R
    }

    @Suppress("UNCHECKED_CAST")
    internal fun <T : Any, R : Any> emit(port: ProductComponentEvent<T, R>, event: T): R {
        check(port.id in componentEventEmitters) {
            "Component event ${port.id.value} has no active native emitter"
        }
        val binding = requireComponentEventBinding(port)
        val result = requireNotNull(inputSinks[binding.to]) {
            "Missing native input binding for required port ${binding.to.value}"
        }.sink(event)
        publishConnected(binding, event, ProductPortQuality.LIVE)
        return result as R
    }

    private fun requireComponentEventBinding(port: ProductComponentEvent<*, *>): GeneratedProductPortBinding {
        return graph.requireComponentEventBinding(port)
    }

    @Suppress("UNCHECKED_CAST")
    fun <T : Any> value(port: ProductOutputPort<T>): ProductPortValue<T> =
        requireNotNull(values.value[port.id]) {
            "Unknown generated product port ${port.id.value}"
        } as ProductPortValue<T>

    /**
     * Proves that the generated component boundary has one native endpoint at
     * every edge. Duplicate observe/sink registration already fails at the
     * registration site; this closes the other half by rejecting omissions.
     */
    fun requireComponentPortTotality() {
        val requiredOutputs = graph.bindings
            .filterTo(linkedSetOf()) { it.kind == GeneratedProductPortBindingKind.COMPONENT_INPUT }
            .mapTo(linkedSetOf()) { it.from }
        val requiredInputs = graph.bindings
            .filterTo(linkedSetOf()) { it.kind == GeneratedProductPortBindingKind.COMPONENT_EVENT }
            .mapTo(linkedSetOf()) { it.to }
        val requiredComponentInputs = graph.bindings
            .filterTo(linkedSetOf()) { it.kind == GeneratedProductPortBindingKind.COMPONENT_INPUT }
            .mapTo(linkedSetOf()) { it.to }
        val missingOutputs = requiredOutputs - observedOutputs.keys
        val missingInputs = requiredInputs - inputSinks.keys
        val missingComponentInputs = requiredComponentInputs - consumedComponentInputs.keys
        val requiredComponentEvents = graph.bindings
            .filterTo(linkedSetOf()) { it.kind == GeneratedProductPortBindingKind.COMPONENT_EVENT }
            .mapTo(linkedSetOf()) { it.from }
        val missingComponentEvents = requiredComponentEvents - componentEventEmitters.keys
        check(
            missingOutputs.isEmpty() && missingInputs.isEmpty() &&
                missingComponentInputs.isEmpty() && missingComponentEvents.isEmpty()
        ) {
            buildString {
                append("Incomplete generated component native bindings")
                if (missingOutputs.isNotEmpty()) {
                    append("; outputs=")
                    append(missingOutputs.map { it.value }.sorted().joinToString())
                }
                if (missingInputs.isNotEmpty()) {
                    append("; inputs=")
                    append(missingInputs.map { it.value }.sorted().joinToString())
                }
                if (missingComponentInputs.isNotEmpty()) {
                    append("; component-inputs=")
                    append(missingComponentInputs.map { it.value }.sorted().joinToString())
                }
                if (missingComponentEvents.isNotEmpty()) {
                    append("; component-events=")
                    append(missingComponentEvents.map { it.value }.sorted().joinToString())
                }
            }
        }
    }

    /** Every declared service output must feed runtime and inspector truth. */
    fun requireServiceOutputTotality() {
        val required = declarations.values.filterTo(linkedSetOf()) { port ->
            port.ownerKind == GeneratedProductPortOwnerKind.SERVICE &&
                port.direction == GeneratedProductPortDirection.OUTPUT
        }.mapTo(linkedSetOf()) { it.id }
        val missing = required - observedOutputs.keys
        check(missing.isEmpty()) {
            "Generated service outputs lack native values: " +
                missing.map { it.value }.sorted().joinToString()
        }
    }

    /**
     * Every generated service input has exactly one native consumer: a sink
     * bound through [bindInput], or a data consumer attached through
     * [connected]. Link services are all lifetime services with plain data
     * inputs, so no demand or context exception participates in this proof.
     */
    fun requireServiceInputTotality() {
        val required = declarations.values.filterTo(linkedSetOf()) { port ->
            port.ownerKind == GeneratedProductPortOwnerKind.SERVICE &&
                port.direction == GeneratedProductPortDirection.INPUT
        }.mapTo(linkedSetOf()) { it.id }
        val missing = required - inputSinks.keys - consumedDataInputs.keys
        check(missing.isEmpty()) {
            "Generated service inputs lack native consumers: " +
                missing.map { it.value }.sorted().joinToString()
        }
    }

    fun inspectionFlow(refreshMs: Long = 1_000L): Flow<List<ProductPortInspection>> = inspector.flow(refreshMs)

    fun inspections(nowMs: Long = wallClockMs()): List<ProductPortInspection> = inspector.inspections(nowMs)

    private fun publish(id: GeneratedProductPortId, value: Any, quality: ProductPortQuality) {
        publish(mapOf(id to ProductPortValue(value, wallClockMs(), quality)))
    }

    private fun publishConnected(
        binding: GeneratedProductPortBinding,
        value: Any,
        quality: ProductPortQuality,
    ) {
        val snapshot = ProductPortValue(value, wallClockMs(), quality)
        publish(mapOf(binding.from to snapshot, binding.to to snapshot))
    }

    private fun publish(next: Map<GeneratedProductPortId, ProductPortValue<Any?>>) {
        values.update { previous ->
            previous + next
        }
    }

    private fun markBound(id: GeneratedProductPortId) {
        values.update { previous ->
            previous + (id to ProductPortValue(null, null, ProductPortQuality.UNAVAILABLE))
        }
    }

    private fun markUnbound(id: GeneratedProductPortId) {
        values.update { previous ->
            previous + (id to ProductPortValue(null, null, ProductPortQuality.UNBOUND))
        }
    }

    @Synchronized
    private fun registerDataInput(id: GeneratedProductPortId): Any = Any().also { token ->
        check(consumedDataInputs.putIfAbsent(id, token) == null) {
            "Product data input ${id.value} already has a native consumer"
        }
    }

    @Synchronized
    private fun removeDataInput(id: GeneratedProductPortId, token: Any) {
        if (consumedDataInputs[id] === token) consumedDataInputs.remove(id)
    }

    @Synchronized
    private fun registerComponentInput(id: GeneratedProductPortId): Any = Any().also { token ->
        check(consumedComponentInputs.putIfAbsent(id, token) == null) {
            "Product component input ${id.value} already has a native consumer"
        }
    }

    @Synchronized
    private fun removeComponentInput(id: GeneratedProductPortId, token: Any) {
        if (consumedComponentInputs[id] === token) consumedComponentInputs.remove(id)
    }

    @Synchronized
    private fun registerComponentEvent(id: GeneratedProductPortId): Any = Any().also { token ->
        check(componentEventEmitters.putIfAbsent(id, token) == null) {
            "Product component event ${id.value} already has a native emitter"
        }
    }

    @Synchronized
    private fun removeComponentEvent(id: GeneratedProductPortId, token: Any) {
        if (componentEventEmitters[id] === token) componentEventEmitters.remove(id)
    }

    @Synchronized
    private fun removeOutput(id: GeneratedProductPortId, token: Any) {
        if (observedOutputs[id] === token) {
            observedOutputs.remove(id)
            markUnbound(id)
        }
    }

    @Synchronized
    private fun removeInput(id: GeneratedProductPortId, token: Any) {
        if (inputSinks[id]?.token === token) {
            inputSinks.remove(id)
            markUnbound(id)
        }
    }

    private fun requirePort(id: GeneratedProductPortId, direction: GeneratedProductPortDirection): GeneratedProductPort {
        return graph.requirePort(id, direction)
    }
}
