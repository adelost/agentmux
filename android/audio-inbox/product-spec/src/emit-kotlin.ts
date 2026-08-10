import { createHash } from "node:crypto";
import type {
  CompiledStateAuthority,
  ComponentRenderContractIr,
  LegoFiniteValueDeclaration,
  OutputArtifact,
  ProductEmitterPlugin,
  ProductIr,
  ScreenComponentFamilyRef,
  StatePresentationField,
  SurfaceFamily,
} from "@v1d/product-spec";
import { linkPagePresentations, linkSettingsActionPresentation } from "./routes.js";

const packageName = "io.agentmux.linkui.product.generated";

/**
 * Link's native emitter: projects the compiled ProductSpec port graph and the
 * component families into the exact Kotlin the Android runtime, renderer
 * attestation and inspector read. Shapes mirror the SVW-0124 catalog so the
 * native engine stays a mechanical port; the generic graph laws are enforced
 * by @v1d/product-spec before anything is emitted.
 */
export function linkNativeEmitter(kotlinRoot: string): ProductEmitterPlugin {
  return {
    id: "link-native",
    emit(product) {
      const catalogSha = fingerprint({
        ports: product.portRegistry.nodePorts,
        componentPorts: product.portRegistry.componentPorts,
        bindings: product.portRegistry.bindings,
        demandEdges: product.portRegistry.demandEdges,
        finiteValues: product.finiteValues,
      });
      const familiesSha = fingerprint(product.componentFamilies);
      return [
        artifact("catalog-types", `${kotlinRoot}/GeneratedLinkNativeLegoCatalogTypes.kt`,
          emitCatalogTypes(catalogSha)),
        artifact("catalog", `${kotlinRoot}/GeneratedLinkNativeLegoCatalog.kt`,
          emitCatalogAggregate(product, catalogSha)),
        artifact("catalog-ports", `${kotlinRoot}/GeneratedLinkNativeLegoCatalogPortData.kt`,
          emitPortData(product, catalogSha)),
        artifact("catalog-bindings", `${kotlinRoot}/GeneratedLinkNativeLegoCatalogPortBindings.kt`,
          emitPortBindings(product, catalogSha)),
        artifact("state-presentations", `${kotlinRoot}/GeneratedLinkStatePresentations.kt`,
          emitStatePresentations(product.stateAuthorities, fingerprint(product.stateAuthorities))),
        artifact("routes", `${kotlinRoot}/GeneratedLinkRoutes.kt`,
          emitRoutes(product, fingerprint({
            pages: product.navigation.pages,
            presentations: linkPagePresentations,
            settingsAction: linkSettingsActionPresentation,
          }))),
        artifact("component-families", `${kotlinRoot}/GeneratedLinkComponentFamilies.kt`,
          emitComponentFamilies(product, familiesSha)),
        artifact("component-render-contracts", `${kotlinRoot}/GeneratedLinkComponentRenderContracts.kt`,
          emitComponentRenderContracts(product.componentRenderContracts,
            fingerprint(product.componentRenderContracts))),
        ...product.componentFamilies.map((entry) => {
          const name = `Generated${kotlinIdentifier(entry.family.id)}Components`;
          return artifact(
            `components-${name}`,
            `${kotlinRoot}/${name}.kt`,
            emitComponentTree(entry, familiesSha),
          );
        }),
      ];
    },
  };
}

function emitComponentRenderContracts(
  contracts: readonly ComponentRenderContractIr[],
  sha: string,
): string {
  const inputs = contracts.flatMap((contract) => contract.inputs.map((input) => ({ contract, input })));
  const events = contracts.flatMap((contract) => contract.events.map((event) => ({ contract, event })));
  const scopes = contracts.flatMap((contract) => contract.scopes.map((scope) => ({ contract, scope })));
  const bundles = contracts.map((contract) => {
    const name = `Generated${kotlinIdentifier(contract.componentInstanceRef)}RenderInputs`;
    const fields = contract.inputs.map((input) =>
      `    val ${kotlinProperty(input.inputPortRef)}: ${rendererInputType(input.contractRef)},`
    ).join("\n");
    return contract.inputs.length === 0
      ? `data object ${name}`
      : `data class ${name}(\n${fields}\n)`;
  }).join("\n\n");
  const emitters = contracts.map((contract) => {
    const name = `Generated${kotlinIdentifier(contract.componentInstanceRef)}RenderEmitter`;
    if (contract.events.length === 0) return `data object ${name}`;
    const methods = contract.events.map((event) =>
      `    fun ${kotlinProperty(event.eventPortRef)}(event: ${rendererEventType(event.contractRef)})`
    ).join("\n");
    return `${contract.events.length === 1 ? "fun " : ""}interface ${name} {\n${methods}\n}`;
  }).join("\n\n");
  return `${header("ProductIr.componentRenderContracts", sha)}
import io.agentmux.linkui.product.*

data class GeneratedLinkRendererIdentity(
    val instanceRef: String,
    val typeRef: String,
)
data class GeneratedLinkRendererScope(
    val component: GeneratedLinkComponentId,
    val artifact: GeneratedLinkArtifactRef,
    val page: GeneratedLinkPageId,
    val surface: String,
    val mountRef: String,
)
data class GeneratedLinkRendererInput(
    val component: GeneratedLinkComponentId,
    val inputPortRef: String,
    val producerPortRef: String,
    val contractRef: String,
    val required: Boolean,
)
data class GeneratedLinkRendererEvent(
    val component: GeneratedLinkComponentId,
    val eventPortRef: String,
    val targetPortRef: String,
    val contractRef: String,
)

enum class GeneratedLinkRendererScopeId(val declaration: GeneratedLinkRendererScope) {
${scopes.map(({ contract, scope }) => `    ${kotlinEnumToken(`${contract.componentInstanceRef}-${scope.artifactRef}-${scope.screenRef}-${scope.surface}-${scope.mountRef}`)}(GeneratedLinkRendererScope(GeneratedLinkComponentId.${kotlinEnumToken(contract.componentInstanceRef)}, GeneratedLinkArtifactRef.${kotlinEnumToken(scope.artifactRef)}, GeneratedLinkPageId.${kotlinEnumToken(scope.screenRef)}, ${JSON.stringify(scope.surface)}, ${JSON.stringify(scope.mountRef)})),`).join("\n")}
}
enum class GeneratedLinkRendererInputId(val declaration: GeneratedLinkRendererInput) {
${inputs.map(({ contract, input }) => `    ${kotlinEnumToken(input.inputPortRef)}(GeneratedLinkRendererInput(GeneratedLinkComponentId.${kotlinEnumToken(contract.componentInstanceRef)}, ${JSON.stringify(input.inputPortRef)}, ${JSON.stringify(input.producerPortRef)}, ${JSON.stringify(input.contractRef)}, ${input.required})),`).join("\n")}
}
enum class GeneratedLinkRendererEventId(val declaration: GeneratedLinkRendererEvent) {
${events.map(({ contract, event }) => `    ${kotlinEnumToken(event.eventPortRef)}(GeneratedLinkRendererEvent(GeneratedLinkComponentId.${kotlinEnumToken(contract.componentInstanceRef)}, ${JSON.stringify(event.eventPortRef)}, ${JSON.stringify(event.targetPortRef)}, ${JSON.stringify(event.contractRef)})),`).join("\n")}
}
object GeneratedLinkRendererIdentities {
${contracts.map((contract) => `    val ${kotlinEnumToken(contract.componentInstanceRef)} = GeneratedLinkRendererIdentity(${JSON.stringify(contract.componentInstanceRef)}, ${JSON.stringify(contract.componentTypeRef)})`).join("\n")}
}

${bundles}

${emitters}
`;
}

function kotlinProperty(portRef: string): string {
  const name = portRef.slice(portRef.indexOf(".") + 1);
  return name.replace(/-([a-z])/gu, (_, char: string) => char.toUpperCase());
}

function rendererInputType(contractRef: string): string {
  const types: Readonly<Record<string, string>> = {
    "link.navigation.active-page": "LinkRoute",
    "link.target-directory": "LinkTargetPresentation",
    "link.target-kind.payload": "GeneratedLinkTargetKindPresentation",
    "link.session-status": "LinkSessionPresentation",
    "link.connection-state.payload": "GeneratedLinkConnectionStatePresentation",
    "link.recovery-status": "LinkRecoveryPresentation",
    "link.recovery-phase.payload": "GeneratedLinkRecoveryPhasePresentation",
    "link.capture-status": "LinkCapturePresentation",
    "link.capture-phase.payload": "GeneratedLinkCapturePhasePresentation",
    "link.conversation-status": "LinkConversationPresentation",
    "link.delivery-phase.payload": "GeneratedLinkDeliveryPhasePresentation",
    "link.reply-phase.payload": "GeneratedLinkReplyPhasePresentation",
    "link.playback-status": "LinkPlaybackPresentation",
    "link.playback-phase.payload": "GeneratedLinkPlaybackPhasePresentation",
    "link.preferences-status": "LinkPreferencesPresentation",
    "link.history-status": "LinkHistoryPresentation",
    "link.update-status": "LinkUpdatePresentation",
    "link.update-phase.payload": "GeneratedLinkUpdatePhasePresentation",
    "link.dev-preview-status": "LinkDevPreviewPresentation",
  };
  const result = types[contractRef];
  if (result === undefined) throw new Error(`No native renderer input type for '${contractRef}'`);
  return result;
}

function rendererEventType(contractRef: string): string {
  const types: Readonly<Record<string, string>> = {
    "link.target-select": "LinkTargetSelectEvent",
    "link.capture-command": "LinkCaptureCommandEvent",
    "link.playback-command": "LinkPlaybackCommandEvent",
    "link.open-attachment": "LinkOpenAttachmentEvent",
    "link.compose-turn": "LinkComposeEvent",
    "link.edit-composer": "LinkComposerEditEvent",
    "link.public-link-command": "LinkPublicLinkCommandEvent",
    "link.preference-toggle": "LinkPreferenceToggleEvent",
    "link.update-command": "LinkUpdateCommandEvent",
    "link.navigation.route-intent": "LinkRouteOpenEvent",
    "link.navigation-back": "LinkNavigationBackEvent",
  };
  const result = types[contractRef];
  if (result === undefined) throw new Error(`No native renderer event type for '${contractRef}'`);
  return result;
}

function emitCatalogTypes(sha: string): string {
  return `${header("the portable native-Lego catalog type vocabulary", sha)}
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
`;
}

function emitCatalogAggregate(product: ProductIr, sha: string): string {
  const ports = [...product.portRegistry.nodePorts, ...product.portRegistry.componentPorts];
  const portIdObjects = ports.map((port) => {
    const face = port.direction === "input" ? "GeneratedProductInputPortId" : "GeneratedProductOutputPortId";
    return `        data object ${kotlinEnumToken(port.ref)} : ${face} { override val value = "${port.ref}" }`;
  }).join("\n");
  const finiteIdObjects = product.finiteValues.map((declaration) =>
    `        data object ${kotlinEnumToken(declaration.id)} : GeneratedLinkFiniteValueId { override val value = "${declaration.id}" }`
  ).join("\n");
  const finiteValues = product.finiteValues.map((declaration) =>
    `        GeneratedLinkFiniteValueDeclaration(FiniteValueIds.${kotlinEnumToken(declaration.id)}, setOf(${declaration.values.map((value) => `"${value}"`).join(", ")}))`
  ).join(",\n");
  const nodes = product.nodes.map(({ id }) => `${kotlinEnumToken(id)}("${id}")`).join(", ");
  return `${header("the portable native-Lego catalog", sha)}
internal enum class GeneratedLinkNodeId(val wireId: String) { ${nodes} }

internal object GeneratedLinkNativeLegoCatalog {
    object PortIds {
${portIdObjects}
    }
    object FiniteValueIds {
${finiteIdObjects}
    }
    val finiteValues: List<GeneratedLinkFiniteValueDeclaration> = listOf(
${finiteValues}
    )
    val ports: List<GeneratedProductPort> = GeneratedLinkNativeLegoPortData.ports
    val portBindings: List<GeneratedProductPortBinding> = GeneratedLinkNativeLegoPortBindings.bindings
    val demandEdges: List<GeneratedProductDemandEdge> = emptyList()
    val allEdges: Set<GeneratedLinkNativeLegoEdge> = portBindings.mapTo(linkedSetOf()) {
        GeneratedLinkNativeLegoEdge(it.from.value, it.to.value)
    }
}
`;
}

function emitStatePresentations(
  authorities: readonly CompiledStateAuthority[],
  sha: string,
): string {
  const finiteValues = uniquePresentationFiniteValues(authorities);
  return `${header("ProductConfig.stateAuthorities", sha)}
import io.agentmux.linkui.product.ProductComponentInput
import io.agentmux.linkui.product.ProductDataInput
import io.agentmux.linkui.product.ProductOutputPort

${finiteValues.map(emitPresentationFiniteEnum).join("\n")}
${authorities.map(emitStatePresentation).join("\n")}
`;
}

function emitPresentationFiniteEnum(declaration: LegoFiniteValueDeclaration): string {
  return `enum class ${presentationFiniteName(declaration)}(val wireId: String) {
${declaration.values.map((value) => `    ${kotlinEnumToken(value)}("${value}"),`).join("\n")}
}`;
}

function emitStatePresentation(authority: CompiledStateAuthority): string {
  const payload = statePayloadName(authority);
  const objectName = stateAuthorityName(authority);
  const fields = authority.presentation.fields;
  const cases = Object.entries(authority.presentation.cases);
  return `data class ${payload}(
${fields.map((field) => `    val ${field.name}: ${presentationKotlinType(field)},`).join("\n")}
)

internal object ${objectName} {
    fun <T : Any> inputPort(): ProductDataInput<T> = object : ProductDataInput<T>(
        GeneratedLinkNativeLegoCatalog.PortIds.${kotlinEnumToken(authority.adapter.inputPortRef)},
    ) {}
    val outputPort: ProductOutputPort<${payload}> = object : ProductOutputPort<${payload}>(
        GeneratedLinkNativeLegoCatalog.PortIds.${kotlinEnumToken(authority.adapter.outputPortRef)},
    ) {}
    val componentInputs: List<ProductComponentInput<${payload}>> = listOf(
${authority.presentation.consumers.map((ref) => `        object : ProductComponentInput<${payload}>(
            GeneratedLinkNativeLegoCatalog.PortIds.${kotlinEnumToken(ref)},
        ) {},`).join("\n")}
    )
    private val cases: Map<String, ${payload}> = mapOf(
${cases.map(([state, value]) => `        "${state}" to ${payload}(${presentationArguments(fields, value)}),`).join("\n")}
    )

    fun require(stateId: String): ${payload} = requireNotNull(cases[stateId]) {
        "Unknown ${authority.id} state '\$stateId'"
    }
}
`;
}

function presentationArguments(
  fields: readonly StatePresentationField[],
  value: Readonly<Record<string, unknown>>,
): string {
  return fields.map((field) => `${field.name} = ${presentationKotlinValue(field, value[field.name])}`).join(", ");
}

function presentationKotlinType(field: StatePresentationField): string {
  if (typeof field.value !== "string") return presentationFiniteName(field.value);
  switch (field.value) {
    case "boolean": return "Boolean";
    case "integer": return "Long";
    case "number": return "Double";
    case "string": return "String";
  }
}

function presentationKotlinValue(field: StatePresentationField, value: unknown): string {
  if (typeof field.value !== "string") {
    if (typeof value !== "string") throw new Error(`${field.name} finite presentation value is not a string`);
    return `${presentationFiniteName(field.value)}.${kotlinEnumToken(value)}`;
  }
  switch (field.value) {
    case "boolean":
      if (typeof value === "boolean") return String(value);
      break;
    case "integer":
      if (typeof value === "number" && Number.isSafeInteger(value)) return `${value}L`;
      break;
    case "number":
      if (typeof value === "number" && Number.isFinite(value)) return Number.isInteger(value) ? `${value}.0` : String(value);
      break;
    case "string":
      if (typeof value === "string") return JSON.stringify(value);
      break;
  }
  throw new Error(`${field.name} presentation value does not match ${String(field.value)}`);
}

function uniquePresentationFiniteValues(
  authorities: readonly CompiledStateAuthority[],
): readonly LegoFiniteValueDeclaration[] {
  const values = new Map<string, LegoFiniteValueDeclaration>();
  for (const authority of authorities) {
    for (const field of authority.presentation.fields) {
      if (typeof field.value !== "string") values.set(field.value.id, field.value);
    }
  }
  return [...values.values()];
}

function presentationFiniteName(declaration: LegoFiniteValueDeclaration): string {
  return `Generated${kotlinIdentifier(declaration.id)}Value`;
}

function statePayloadName(authority: CompiledStateAuthority): string {
  return `Generated${kotlinIdentifier(authority.id)}Presentation`;
}

function stateAuthorityName(authority: CompiledStateAuthority): string {
  return `Generated${kotlinIdentifier(authority.id)}Authority`;
}

function emitPortData(product: ProductIr, sha: string): string {
  const ports = [...product.portRegistry.nodePorts, ...product.portRegistry.componentPorts];
  const entries = ports.map((port) =>
    `        GeneratedProductPort(GeneratedLinkNativeLegoCatalog.PortIds.${kotlinEnumToken(port.ref)}, ${ownerKind(port.ownerKind)}, "${port.ownerId}", "${port.typeRef}", "${port.portId}", ${direction(port.direction)}, "${port.contractRef}", ${boundary(port.boundary)}, ${port.required}, ${purpose(port.purpose)})`
  ).join(",\n");
  return `${header("the portable native-Lego port registry", sha)}
internal object GeneratedLinkNativeLegoPortData {
    val ports: List<GeneratedProductPort> = listOf(
${entries}
    )
}
`;
}

/**
 * Screen identity as an EXHAUSTIVE `when` over LinkRoute, not a map.
 *
 * A map would answer `null` for a route nobody declared and the header would
 * silently render blank. The `when` makes an undeclared route a compilation
 * error at the exact moment the enum and the declaration disagree, which is
 * the only moment anyone can still fix it cheaply.
 */
function emitRoutes(product: ProductIr, sha: string): string {
  const pageIds = product.navigation.pages.map(({ id }) => id);
  const presentations = new Map<string, (typeof linkPagePresentations)[number]>(
    linkPagePresentations.map((page) => [page.id, page]),
  );
  if (presentations.size !== pageIds.length || pageIds.some((id) => !presentations.has(id))) {
    throw new Error("Link page presentation metadata must exactly cover compiled navigation pages");
  }
  const branches = pageIds.map((pageId) => {
    const page = presentations.get(pageId);
    if (page === undefined) throw new Error(`Link page '${pageId}' has no presentation metadata`);
    return `        GeneratedLinkPageId.${kotlinEnumToken(pageId)} -> GeneratedLinkRouteDescriptor(route, ${JSON.stringify(page.title)}, "route.${pageId}")`;
  }
  ).join("\n");
  const action = linkSettingsActionPresentation;
  const chromeAction = `    val ${kotlinEnumToken(action.id)}: GeneratedLinkChromeAction = GeneratedLinkChromeAction(
        ${JSON.stringify(action.id)},
        ${JSON.stringify(action.rowKey)},
        ${JSON.stringify(action.title)},
        ${JSON.stringify(action.detail)},
        ${JSON.stringify(action.a11y)},
        ${JSON.stringify(action.iconAssetRef)},
    )`;
  return `${header("the declared route identity (title and icon per screen)", sha)}
enum class GeneratedLinkPageId(val wireId: String) {
${pageIds.map((id) => `    ${kotlinEnumToken(id)}("${id}"),`).join("\n")}
}

data class GeneratedLinkRouteDescriptor(
    val route: GeneratedLinkPageId,
    val title: String,
    val iconId: String,
)

object GeneratedLinkRoutes {
    fun descriptor(route: GeneratedLinkPageId): GeneratedLinkRouteDescriptor = when (route) {
${branches}
    }
}

data class GeneratedLinkChromeAction(
    val id: String,
    val rowKey: String,
    val title: String,
    val detail: String,
    val a11y: String,
    val iconAssetRef: String,
)

object GeneratedLinkChromeActions {
${chromeAction}
}
`;
}

function emitPortBindings(product: ProductIr, sha: string): string {
  const entries = product.portRegistry.bindings.map((binding) =>
    `        GeneratedProductPortBinding(${bindingKind(binding.kind)}, GeneratedLinkNativeLegoCatalog.PortIds.${kotlinEnumToken(binding.from)}, GeneratedLinkNativeLegoCatalog.PortIds.${kotlinEnumToken(binding.to)}, ${purpose(binding.purpose)})`
  ).join(",\n");
  return `${header("the portable native-Lego port bindings", sha)}
internal object GeneratedLinkNativeLegoPortBindings {
    val bindings: List<GeneratedProductPortBinding> = listOf(
${entries}
    )
}
`;
}

function emitComponentFamilies(product: ProductIr, sha: string): string {
  const routes = product.componentFamilies.map(({ screen }) => screen);
  const families = product.componentFamilies.map(({ family }) => family.id);
  const components = product.components;
  const componentTypes = product.componentTypes;
  const artifacts = product.artifacts.map(({ id }) => id);
  const bindings = product.componentFamilies.map(({ screen, family }) => {
    const mounted = family.trees.flatMap((tree) => tree.mounts.map((mount) => mount.instance));
    const distinct = [...new Set(mounted)];
    return `        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkPageId.${kotlinEnumToken(screen)},
            family = GeneratedLinkComponentFamilyRef.${kotlinEnumToken(family.id)},
            components = setOf(${distinct.map((id) => `GeneratedLinkComponentId.${kotlinEnumToken(id)}`).join(", ")}),
        )`;
  }).join(",\n");
  return `${header("ProductConfig.componentFamilies", sha)}
enum class GeneratedLinkComponentFamilyRef(val wireId: String) { ${families.map((id) => `${kotlinEnumToken(id)}("${id}")`).join(", ")} }
enum class GeneratedLinkComponentTypeId(val wireId: String) { ${componentTypes.map(({ id }) => `${kotlinEnumToken(id)}("${id}")`).join(", ")} }
enum class GeneratedLinkComponentId(val wireId: String, val type: GeneratedLinkComponentTypeId) {
    ${components.map((component) => `${kotlinEnumToken(component.id)}("${component.id}", GeneratedLinkComponentTypeId.${kotlinEnumToken(component.componentTypeRef)})`).join(", ")}
}
enum class GeneratedLinkArtifactRef(val wireId: String) { ${artifacts.map((id) => `${kotlinEnumToken(id)}("${id}")`).join(", ")} }

data class GeneratedLinkComponentFamilyBinding(
    val route: GeneratedLinkPageId,
    val family: GeneratedLinkComponentFamilyRef,
    val components: Set<GeneratedLinkComponentId>,
)

object GeneratedLinkComponentFamilies {
    val bindings: Set<GeneratedLinkComponentFamilyBinding> = setOf(
${bindings}
    )

    init {
        require(bindings.map { it.route }.distinct().size == bindings.size)
        require(bindings.map { it.family }.distinct().size == bindings.size)
        val mountedIdentities = bindings.flatMap { binding ->
            binding.components.map { component -> Triple(binding.route, binding.family, component) }
        }
        require(mountedIdentities.distinct().size == mountedIdentities.size)
    }
}
`;
}

function emitComponentTree(entry: ScreenComponentFamilyRef, sha: string): string {
  const family: SurfaceFamily = entry.family;
  const prefix = `Generated${kotlinIdentifier(family.id)}`;
  const surfaces = family.trees.map((tree) => tree.surface);
  const components = family.trees.flatMap((tree) => tree.mounts.map((mount) => mount.instance));
  const regions = [...new Set(family.trees.flatMap((tree) => tree.mounts.map((mount) => mount.region)))];
  const surfaceClass = (surface: string) => {
    switch (surface) {
      case "round": return "CircleSurfaceClass.ROUND";
      case "compact": return "CircleSurfaceClass.PHONE_COMPACT";
      case "wide": return "CircleSurfaceClass.PHONE_WIDE";
      default: throw new Error(`unknown surface '${surface}' in family '${family.id}'`);
    }
  };
  const trees = family.trees.map((tree) => {
    const mounts = tree.mounts.map((mount) =>
      `            ${prefix}Mount(
                id = "${mount.id}",
                component = ${prefix}Component.${kotlinEnumToken(mount.instance)},
                region = ${prefix}Region.${kotlinEnumToken(mount.region)},
                order = ${mount.order},
                priority = ${mount.priority},
                capacity = ${mount.capacity === null ? "null" : mount.capacity},
                required = ${mount.requirement.kind === "required"},
            )`
    ).join(",\n");
    return `        ${surfaceClass(tree.surface)} -> ${prefix}Tree(listOf(\n${mounts}\n        ))`;
  }).join("\n");
  return `${header("ProductConfig.componentFamilies", sha)}
import com.adelost.designkit.ui.CircleSurfaceClass

enum class ${prefix}Component(val id: GeneratedLinkComponentId) {
    ${[...new Set(components)].map((id) => `${kotlinEnumToken(id)}(GeneratedLinkComponentId.${kotlinEnumToken(id)})`).join(", ")}
}
enum class ${prefix}Region { ${regions.map((region) => kotlinEnumToken(region)).join(", ")} }

data class ${prefix}Mount(
    val id: String,
    val component: ${prefix}Component,
    val region: ${prefix}Region,
    val order: Int,
    val priority: Int,
    val capacity: Int?,
    val required: Boolean,
)

data class ${prefix}Tree(val mounts: List<${prefix}Mount>) {
    val orderedMounts: List<${prefix}Mount> = mounts.sortedWith(
        compareBy(${prefix}Mount::order).thenBy(${prefix}Mount::priority),
    )

    init {
        require(mounts.map { it.id }.distinct().size == mounts.size)
        require(mounts.map { it.region to it.order }.distinct().size == mounts.size)
        require(mounts == orderedMounts)
    }
}

object ${prefix}Components {
    val declaredSurfaceClasses: Set<CircleSurfaceClass> = setOf(
        ${surfaces.map((surface) => surfaceClass(surface)).join(",\n        ")},
    )

    fun resolve(surfaceClass: CircleSurfaceClass): ${prefix}Tree = when (surfaceClass) {
${trees}
        else -> error("${family.id} does not serve \$surfaceClass")
    }
}
`;
}

function header(source: string, sha: string): string {
  return `// GENERATED FILE. DO NOT EDIT.
// GENERATED FROM ${source}
// Product declarations SHA-256: ${sha}
package ${packageName}
`;
}

function kotlinIdentifier(id: string): string {
  return id.split(/[^A-Za-z0-9]+/u).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function kotlinEnumToken(id: string): string {
  return id.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
}

function ownerKind(kind: "node" | "component"): string {
  return `GeneratedProductPortOwnerKind.${kind === "node" ? "NODE" : "COMPONENT"}`;
}
function direction(value: "input" | "output"): string {
  return `GeneratedProductPortDirection.${value === "input" ? "INPUT" : "OUTPUT"}`;
}
function boundary(value: string): string {
  const token = kotlinEnumToken(value);
  if (!["PRESENTATION", "UI_EVENT", "SERVICE_INTERNAL"].includes(token)) {
    throw new Error(`unknown port boundary '${value}'`);
  }
  return `GeneratedProductPortBoundary.${token}`;
}
function purpose(value: string): string {
  const token = kotlinEnumToken(value);
  if (!["DATA", "DEMAND", "CONTEXT"].includes(token)) {
    throw new Error(`unknown port purpose '${value}'`);
  }
  return `GeneratedProductPortPurpose.${token}`;
}
function bindingKind(kind: string): string {
  const token = kotlinEnumToken(kind);
  if (!["NODE_INPUT", "COMPONENT_INPUT", "COMPONENT_EVENT"].includes(token)) {
    throw new Error(`unknown binding kind '${kind}'`);
  }
  return `GeneratedProductPortBindingKind.${token}`;
}

function artifact(id: string, path: string, content: string): OutputArtifact {
  return { id, path, mediaType: "text/x-kotlin", content };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
