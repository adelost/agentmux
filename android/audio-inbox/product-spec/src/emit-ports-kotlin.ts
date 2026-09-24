import type { ProductIr } from "@v1d/product-spec";
import { header, kotlinEnumToken } from "./emit-kotlin-utils.js";

export function emitPortTrace(product: ProductIr, sha: string, debug: boolean): string {
  const prefix = header("the typed Link port-return boundary", sha);
  if (!debug) return `${prefix}
internal object GeneratedLinkPortTrace {
    fun attach(@Suppress("UNUSED_PARAMETER") callback: (String) -> Unit): AutoCloseable = AutoCloseable {}
    fun returned(@Suppress("UNUSED_PARAMETER") port: GeneratedProductPortId) = Unit
}
`;
  const returnedRefs = [...new Set(product.portRegistry.bindings.map((binding) =>
    binding.kind === "component-event" ? binding.from : binding.to))].sort();
  const rows = returnedRefs.map((ref) => {
    const event = JSON.stringify({ kind: "port", portRef: ref, phase: "returned" });
    return `        GeneratedLinkNativeLegoCatalog.PortIds.${kotlinEnumToken(ref)} -> ${JSON.stringify(event)}`;
  }).join("\n");
  return `${prefix}
/** Test recording and an optional debug observer share the same generated port identities. */
internal object GeneratedLinkPortTrace {
    private val output = System.getenv("V1D_STUDIO_TRACE_DIR")?.takeIf { it.isNotBlank() }?.let {
        java.io.File(it, "kotlin-" + java.util.UUID.randomUUID() + ".jsonl")
    }
    @Volatile private var observer: ((String) -> Unit)? = null

    @Synchronized fun attach(callback: (String) -> Unit): AutoCloseable {
        check(observer == null) { "Link port observation already attached" }
        observer = callback
        return AutoCloseable { synchronized(this) { if (observer === callback) observer = null } }
    }

    @Synchronized fun returned(port: GeneratedProductPortId) {
        val row = when (port) {
${rows}
            else -> return
        }
        try { output?.appendText(row + "\\n") } catch (failure: Exception) {
            System.err.println("Link Studio test trace unavailable: " + failure.javaClass.simpleName)
        }
        try { observer?.invoke(row) } catch (failure: Exception) {
            System.err.println("Link Studio observation unavailable: " + failure.javaClass.simpleName)
        }
    }
}
`;
}

export function emitPortData(product: ProductIr, sha: string): string {
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

export function emitPortBindings(product: ProductIr, sha: string): string {
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
