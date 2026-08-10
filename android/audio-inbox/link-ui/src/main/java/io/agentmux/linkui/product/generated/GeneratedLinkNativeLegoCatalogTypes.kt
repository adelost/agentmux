// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM the portable native-Lego catalog type vocabulary
// Product declarations SHA-256: a388fdac3743216a71b8f3285bb4f78dfcd53b187b62fab5fb785c02cffb7e7c
package io.agentmux.linkui.product.generated

internal interface GeneratedLinkFiniteValueId { val value: String }
internal sealed interface GeneratedProductPortId { val value: String }
internal sealed interface GeneratedProductInputPortId : GeneratedProductPortId
internal sealed interface GeneratedProductOutputPortId : GeneratedProductPortId
internal data class GeneratedLinkFiniteValueDeclaration(
    val id: GeneratedLinkFiniteValueId,
    val values: Set<String>,
)
internal enum class GeneratedProductPortOwnerKind { NODE, COMPONENT }
internal enum class GeneratedProductPortDirection { INPUT, OUTPUT }
internal enum class GeneratedProductPortBoundary { PRESENTATION, UI_EVENT, SERVICE_INTERNAL }
internal enum class GeneratedProductPortPurpose { DATA, DEMAND, CONTEXT }
internal data class GeneratedProductPort(
    val id: GeneratedProductPortId,
    val ownerKind: GeneratedProductPortOwnerKind,
    val ownerId: String,
    val typeRef: String,
    val portId: String,
    val direction: GeneratedProductPortDirection,
    val contractRef: String,
    val boundary: GeneratedProductPortBoundary,
    val required: Boolean,
    val purpose: GeneratedProductPortPurpose,
)
internal enum class GeneratedProductPortBindingKind { NODE_INPUT, COMPONENT_INPUT, COMPONENT_EVENT }
internal data class GeneratedProductPortBinding(
    val kind: GeneratedProductPortBindingKind,
    val from: GeneratedProductOutputPortId,
    val to: GeneratedProductInputPortId,
    val purpose: GeneratedProductPortPurpose,
)
internal data class GeneratedLinkNativeLegoEdge(val from: String, val to: String)
internal data class GeneratedProductDemandEdge(
    val kind: String,
    val nodeInstanceRef: String,
    val targetPortRef: GeneratedProductInputPortId,
    val source: String? = null,
    val rootNodeInstanceRef: String? = null,
    val artifactRef: String? = null,
    val screenRef: String? = null,
    val surface: String? = null,
    val mountRef: String? = null,
    val componentInstanceRef: String? = null,
)
