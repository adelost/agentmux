package io.agentmux.linkui.product

import androidx.compose.runtime.Composable
import io.agentmux.linkui.product.generated.GeneratedLinkComponentId
import io.agentmux.linkui.product.generated.GeneratedLinkRendererEventId
import io.agentmux.linkui.product.generated.GeneratedLinkRendererInputId
import io.agentmux.linkui.product.generated.GeneratedLinkRendererScopeId

/**
 * Binds generated identity tokens to executable host endpoints. The host must
 * name every scope/input/event explicitly; no expected IR list is accepted.
 */
fun LinkProductGraph.nativeRendererRegistration(
    component: GeneratedLinkComponentId,
    scopes: List<GeneratedLinkRendererScopeId>,
    inputs: List<GeneratedLinkRendererInputId>,
    events: List<GeneratedLinkRendererEventId>,
    mount: @Composable (inputs: Any, emitter: Any) -> Unit,
): LinkNativeComponentRendererRegistration = LinkNativeComponentRendererRegistration(
    component = component,
    mounts = scopes.map { scope -> LinkNativeRendererMountRegistration(scope, mount) },
    immutableInputs = inputs.map { input ->
        LinkNativeRendererInputRegistration(input) { readRendererInput(input) }
    },
    eventEmitter = if (events.isEmpty()) {
        LinkNativeRendererEmitterRegistration.Empty()
    } else {
        LinkNativeRendererEmitterRegistration.Typed(events.map { event ->
            LinkNativeRendererEventRegistration(event) { payload -> emitRendererEvent(event, payload) }
        })
    },
)
