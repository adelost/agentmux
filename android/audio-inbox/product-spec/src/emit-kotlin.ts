import { createHash } from "node:crypto";
import type {
  LegoFiniteValueDeclaration,
  OutputArtifact,
  ProductEmitterPlugin,
  ProductIr,
  ScreenComponentFamilyRef,
  SurfaceFamily,
} from "@v1d/product-spec";
import { linkRoutes } from "./routes.js";

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
        ports: product.portRegistry.servicePorts,
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
        artifact("routes", `${kotlinRoot}/GeneratedLinkRoutes.kt`,
          emitRoutes(fingerprint(linkRoutes))),
        artifact("component-families", `${kotlinRoot}/GeneratedLinkComponentFamilies.kt`,
          emitComponentFamilies(product, familiesSha)),
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
internal enum class GeneratedProductPortOwnerKind { SERVICE, COMPONENT }
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
internal enum class GeneratedProductPortBindingKind { SERVICE_INPUT, COMPONENT_INPUT, COMPONENT_EVENT }
internal data class GeneratedProductPortBinding(
    val kind: GeneratedProductPortBindingKind,
    val from: GeneratedProductOutputPortId,
    val to: GeneratedProductInputPortId,
    val purpose: GeneratedProductPortPurpose,
)
internal data class GeneratedLinkNativeLegoEdge(val from: String, val to: String)
internal data class GeneratedProductDemandEdge(
    val kind: String,
    val serviceInstanceRef: String,
    val targetPortRef: GeneratedProductInputPortId,
    val source: String? = null,
    val rootServiceInstanceRef: String? = null,
    val artifactRef: String? = null,
    val screenRef: String? = null,
    val surface: String? = null,
    val mountRef: String? = null,
    val componentInstanceRef: String? = null,
)
`;
}

function emitCatalogAggregate(product: ProductIr, sha: string): string {
  const ports = [...product.portRegistry.servicePorts, ...product.portRegistry.componentPorts];
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
  return `${header("the portable native-Lego catalog", sha)}
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

function emitPortData(product: ProductIr, sha: string): string {
  const ports = [...product.portRegistry.servicePorts, ...product.portRegistry.componentPorts];
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
function emitRoutes(sha: string): string {
  const branches = linkRoutes.map((route) =>
    `        LinkRoute.${kotlinEnumToken(route.id)} -> GeneratedLinkRouteDescriptor(route, ${JSON.stringify(route.title)}, "route.${route.id}")`
  ).join("\n");
  return `${header("the declared route identity (title and icon per screen)", sha)}
import io.agentmux.linkui.product.LinkRoute

data class GeneratedLinkRouteDescriptor(
    val route: LinkRoute,
    val title: String,
    val iconId: String,
)

object GeneratedLinkRoutes {
    fun descriptor(route: LinkRoute): GeneratedLinkRouteDescriptor = when (route) {
${branches}
    }
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
  const artifacts = product.artifacts.map(({ id }) => id);
  const bindings = product.componentFamilies.map(({ screen, family }) => {
    const mounted = family.trees.flatMap((tree) => tree.mounts.map((mount) => mount.instance));
    const distinct = [...new Set(mounted)];
    return `        GeneratedLinkComponentFamilyBinding(
            route = GeneratedLinkRouteRef.${kotlinEnumToken(screen)},
            family = GeneratedLinkComponentFamilyRef.${kotlinEnumToken(family.id)},
            components = setOf(${distinct.map((id) => `GeneratedLinkComponentId.${kotlinEnumToken(id)}`).join(", ")}),
        )`;
  }).join(",\n");
  return `${header("ProductConfig.componentFamilies", sha)}
enum class GeneratedLinkRouteRef(val wireId: String) { ${routes.map((id) => `${kotlinEnumToken(id)}("${id}")`).join(", ")} }
enum class GeneratedLinkComponentFamilyRef(val wireId: String) { ${families.map((id) => `${kotlinEnumToken(id)}("${id}")`).join(", ")} }
enum class GeneratedLinkComponentId(val wireId: String, val typeId: String) { ${components.map((component) => `${kotlinEnumToken(component.id)}("${component.id}", "${component.componentTypeRef}")`).join(", ")} }
enum class GeneratedLinkArtifactRef(val wireId: String) { ${artifacts.map((id) => `${kotlinEnumToken(id)}("${id}")`).join(", ")} }

data class GeneratedLinkComponentFamilyBinding(
    val route: GeneratedLinkRouteRef,
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

function ownerKind(kind: "service" | "component"): string {
  return `GeneratedProductPortOwnerKind.${kind === "service" ? "SERVICE" : "COMPONENT"}`;
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
  if (!["SERVICE_INPUT", "COMPONENT_INPUT", "COMPONENT_EVENT"].includes(token)) {
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
