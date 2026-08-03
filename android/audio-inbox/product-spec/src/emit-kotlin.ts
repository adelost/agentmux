import type { LegoContract, LegoField, ProductEmitterPlugin, ProductIr } from "@v1d/product-spec";
import type { AgentmuxLinkProductIr } from "./product.js";

export function linkKotlinEmitter(path: string): ProductEmitterPlugin {
  return {
    id: "link-kotlin",
    emit(product) {
      const link = requireLinkProduct(product);
      return [{ id: "link-kotlin", path, mediaType: "text/x-kotlin", content: emitKotlin(link) }];
    },
  };
}

function requireLinkProduct(product: ProductIr): AgentmuxLinkProductIr {
  if (product.id !== "agentmux-link" || !("link" in product)) {
    throw new Error("Link Kotlin emitter received another product");
  }
  return product as AgentmuxLinkProductIr;
}

function emitKotlin(product: AgentmuxLinkProductIr): string {
  const profiles = product.artifacts.map((item) =>
    `    ${enumName(item.id)}(${str(item.id)}, setOf(${item.serves.map(str).join(", ")})),`).join("\n");
  const routes = product.link.routes.map((item) =>
    `    ${enumName(item.id)}(${str(item.id)}),`).join("\n");
  const finiteEnums = product.finiteValues
    .filter(({ id }) => id !== "link.route")
    .map(({ id, values }) => `enum class ${contractName(id)}(val id: String) {\n${values
      .map((value) => `    ${enumName(value)}(${str(value)}),`).join("\n")}\n}`)
    .join("\n");
  const finiteValues = product.finiteValues.map(({ id, values }) =>
    `        LinkFiniteValueDeclaration(${str(id)}, setOf(${values.map(str).join(", ")})),`).join("\n");
  const actions = product.link.menuActions.map((item) =>
    `    ${enumName(item.id)}(${str(item.id)}),`).join("\n");
  const componentIds = product.componentCatalog.map((item) =>
    `    ${enumName(item.id)}(${str(item.id)}),`).join("\n");
  const routeDescriptors = product.link.routes.map((item) =>
    `        LinkRouteDescriptor(LinkRoute.${enumName(item.id)}, ${str(item.title)}, ${str(iconAsset(product, `route.${item.id}`))}, setOf(${item.artifacts.map((id) => `LinkArtifactProfile.${enumName(id)}`).join(", ")})),`).join("\n");
  const actionDescriptors = product.link.menuActions.map((item) =>
    `        LinkMenuActionDescriptor(LinkMenuAction.${enumName(item.id)}, ${str(item.rowId)}, ${str(item.title)}, ${str(item.detail)}, ${str(item.a11y)}, ${str(iconAsset(product, `action.${item.id}`))}, LinkRoute.${enumName(item.destination)}, setOf(${item.artifacts.map((id) => `LinkArtifactProfile.${enumName(id)}`).join(", ")})),`).join("\n");
  const components = product.componentCatalog.map((item) => {
    const native = product.link.nativeComponents.find(({ componentId }) => componentId === item.id);
    if (native === undefined) throw new Error(`Component '${item.id}' has no native binding`);
    const artifacts = componentArtifacts(product, item.id);
    return `        LinkComponentDescriptor(LinkComponentId.${enumName(item.id)}, ${str(native.rendererId)}, ${str(iconAsset(product, `component.${item.id}`))}, setOf(${artifacts.map((id) => `LinkArtifactProfile.${enumName(id)}`).join(", ")})),`;
  }).join("\n");
  const trees = product.componentFamilies.flatMap(({ screen, family }) =>
    family.trees.map((tree) => {
      const mounts = tree.mounts.map((item) =>
        `LinkComponentMount(LinkComponentId.${enumName(item.component)}, ${str(item.region)}, ${item.order}, ${item.requirement.kind === "optional"})`).join(", ");
      return `        LinkComponentTree(LinkRoute.${enumName(screen)}, ${str(tree.surface)}, listOf(${mounts})),`;
    })).join("\n");
  const services = product.legos.mounts.map((item) => {
    const inputs = item.lego.inputs.map(({ id }) => str(id)).join(", ");
    const outputs = item.lego.outputs.map(({ id }) => str(id)).join(", ");
    const runtime = item.lego.runtime;
    const native = product.link.nativeServices.find(({ serviceId }) => serviceId === item.id);
    if (native === undefined) throw new Error(`Service '${item.id}' has no native port binding`);
    return `        LinkServiceDescriptor(${str(item.id)}, ${str(native.nativePortId)}, listOf(${inputs}), listOf(${outputs}), ${str(runtime.stateOwner)}, ${str(runtime.lifetime)}, ${str(runtime.durability)}, ${str(runtime.clockDomain)}, listOf(${runtime.contextInputs.map(str).join(", ")}), listOf(${runtime.effects.map(str).join(", ")})),`;
  }).join("\n");
  const contracts = product.legos.contracts.map((contract) => emitContract(product, contract)).join("\n");
  const ports = product.legos.mounts.map((mount) => {
    const members = [
      ...mount.lego.inputs.map((port) =>
        `    fun ${port.id}(value: ${contractName(port.contract.id)})`),
      ...mount.lego.outputs.map((port) =>
        `    fun ${port.id}(): ${contractName(port.contract.id)}${port.contract.kind === "state" ? "" : "?"}`),
    ].join("\n");
    return `interface ${servicePortName(mount.id)} {\n${members}\n}`;
  }).join("\n");
  const graphMembers = product.legos.mounts.map((mount) =>
    `    val ${mount.id}: ${servicePortName(mount.id)}`).join("\n");
  const edges = product.legos.wiring.map((edge) => {
    const name = enumName(`${edge.from}-to-${edge.to}`);
    const [fromService, fromPort] = portRef(edge.from);
    const [toService, toPort] = portRef(edge.to);
    return { name, value: `LinkServiceEdge(${str(fromService)}, ${str(fromPort)}, ${str(toService)}, ${str(toPort)})` };
  });
  const edgeConstants = edges.map(({ name, value }) => `    val ${name}: LinkServiceEdge = ${value}`).join("\n");
  const edgeList = edges.map(({ name }) => name).join(", ");

  return `// Generated by product-spec/src/generate.ts. Do not edit.
package io.agentmux.linkui.product.generated

enum class LinkArtifactProfile(val id: String, val surfaces: Set<String>) {
${profiles}
}
enum class LinkRoute(val id: String) {
${routes}
}
${finiteEnums}
enum class LinkMenuAction(val id: String) {
${actions}
}
enum class LinkComponentId(val id: String) {
${componentIds}
}
${contracts}
${ports}
interface LinkNativePortGraph {
${graphMembers}
}
data class LinkRouteDescriptor(val route: LinkRoute, val title: String, val iconId: String, val artifacts: Set<LinkArtifactProfile>)
data class LinkMenuActionDescriptor(val action: LinkMenuAction, val rowId: String, val title: String, val detail: String, val contentDescription: String, val iconId: String, val destination: LinkRoute, val artifacts: Set<LinkArtifactProfile>)
data class LinkComponentDescriptor(val id: LinkComponentId, val rendererId: String, val iconId: String, val artifacts: Set<LinkArtifactProfile>)
data class LinkComponentMount(val component: LinkComponentId, val region: String, val order: Int, val optional: Boolean)
data class LinkComponentTree(val route: LinkRoute, val surface: String, val mounts: List<LinkComponentMount>)
data class LinkServiceDescriptor(val id: String, val nativePortId: String, val inputPorts: List<String>, val outputPorts: List<String>, val stateOwner: String, val lifetime: String, val durability: String, val clockDomain: String, val contextInputs: List<String>, val effects: List<String>)
data class LinkServiceEdge(val fromService: String, val fromPort: String, val toService: String, val toPort: String)
data class LinkFiniteValueDeclaration(val id: String, val values: Set<String>)

object LinkProductWiring {
${edgeConstants}
    val all: List<LinkServiceEdge> = listOf(${edgeList})
}

object LinkProductManifest {
    const val PRODUCT_ID: String = ${str(product.id)}
    const val PRODUCT_SPEC_VERSION: String = ${str(product.productSpecVersion)}
    const val ASSET_CATALOG_ID: String = ${str(product.assetCatalogRef.id)}
    const val ASSET_CATALOG_VERSION: String = ${str(product.assetCatalogRef.version)}
    val routes: List<LinkRouteDescriptor> = listOf(
${routeDescriptors}
    )
    val menuActions: List<LinkMenuActionDescriptor> = listOf(
${actionDescriptors}
    )
    val components: List<LinkComponentDescriptor> = listOf(
${components}
    )
    val componentTrees: List<LinkComponentTree> = listOf(
${trees}
    )
    val services: List<LinkServiceDescriptor> = listOf(
${services}
    )
    val finiteValues: List<LinkFiniteValueDeclaration> = listOf(
${finiteValues}
    )
    fun route(route: LinkRoute): LinkRouteDescriptor = routes.single { it.route == route }
    fun action(action: LinkMenuAction): LinkMenuActionDescriptor = menuActions.single { it.action == action }
    fun component(id: LinkComponentId): LinkComponentDescriptor = components.single { it.id == id }
    fun tree(route: LinkRoute, surface: String): LinkComponentTree = componentTrees.single { it.route == route && it.surface == surface }
}
`;
}

function emitContract(product: AgentmuxLinkProductIr, contract: LegoContract): string {
  const fields = contract.fields.map((item) =>
    `    val ${item.name}: ${kotlinType(product, item)}`).join(",\n");
  return `data class ${contractName(contract.id)}(\n${fields},\n)`;
}

function kotlinType(product: AgentmuxLinkProductIr, field: LegoField): string {
  const value = field.value;
  if (typeof value !== "string") {
    const declared = product.finiteValues.some(({ id }) => id === value.ref);
    const finite = "finite" in value && value.finite === true;
    if (!declared || !finite) {
      throw new Error(`Contract field '${field.name}' uses unsupported value ref '${value.ref}'`);
    }
    const type = value.ref === "link.route" ? "LinkRoute" : contractName(value.ref);
    return `${type}${field.nullable ? "?" : ""}`;
  }
  const base = ({ string: "String", integer: "Long", number: "Double", boolean: "Boolean" } as const)[value];
  return `${base}${field.nullable ? "?" : ""}`;
}

function contractName(id: string): string {
  return id.split(/[^A-Za-z0-9]+/u).filter(Boolean).map(capitalize).join("");
}

function servicePortName(id: string): string {
  return `${id.split(/[^A-Za-z0-9]+/u).filter(Boolean).map(capitalize).join("")}ServicePort`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function portRef(value: string): [string, string] {
  const parts = value.split(".");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid mounted port ref '${value}'`);
  }
  return [parts[0]!, parts[1]!];
}

function iconAsset(product: AgentmuxLinkProductIr, ref: string): string {
  const icon = product.iconRefs.find(({ id }) => id === ref);
  if (icon === undefined) throw new Error(`Missing portable icon ref '${ref}'`);
  return icon.assetRef;
}

function componentArtifacts(product: AgentmuxLinkProductIr, componentId: string): string[] {
  const icon = product.iconRefs.find(({ id }) => id === `component.${componentId}`);
  if (icon === undefined) throw new Error(`Component '${componentId}' has no portable icon ref`);
  return [...icon.artifacts];
}

function enumName(id: string): string {
  return id.replaceAll(/[^A-Za-z0-9]+/gu, "_").toUpperCase();
}
function str(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n")}"`;
}
