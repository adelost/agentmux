export const LINK_NATIVE_REGISTRY_SCHEMA_VERSION = 2 as const;

export interface LinkNativeRegistry {
  readonly stage: "native-export";
  readonly schemaVersion: typeof LINK_NATIVE_REGISTRY_SCHEMA_VERSION;
  readonly sourceFile: string;
  readonly profiles: readonly string[];
  readonly components: readonly {
    componentId: string; rendererId: string; profiles: readonly string[];
  }[];
  readonly icons: readonly { iconId: string; nativeSymbol: string }[];
  readonly services: readonly {
    serviceId: string; nativePortId: string; profiles: readonly string[];
    inputPorts: readonly string[]; outputPorts: readonly string[];
  }[];
  readonly finiteValues: readonly { id: string; values: readonly string[] }[];
}

export function decodeLinkNativeRegistry(raw: unknown): LinkNativeRegistry {
  const root = record(raw, "native registry");
  if (root.stage !== "native-export") throw new Error("native registry is not compiled truth");
  if (root.schemaVersion !== LINK_NATIVE_REGISTRY_SCHEMA_VERSION) {
    throw new Error(`native registry schema ${String(root.schemaVersion)} is unsupported`);
  }
  return {
    stage: "native-export",
    schemaVersion: LINK_NATIVE_REGISTRY_SCHEMA_VERSION,
    sourceFile: requiredString(root.sourceFile, "native registry source file"),
    profiles: strings(root.profiles, "native profiles"),
    components: array(root.components, "native components").map((value, index) => {
      const item = record(value, `native component ${index}`);
      return {
        componentId: requiredString(item.componentId, `native component ${index} id`),
        rendererId: requiredString(item.rendererId, `native component ${index} renderer`),
        profiles: strings(item.profiles, `native component ${index} profiles`),
      };
    }),
    icons: array(root.icons, "native icons").map((value, index) => {
      const item = record(value, `native icon ${index}`);
      return {
        iconId: requiredString(item.iconId, `native icon ${index} id`),
        nativeSymbol: requiredString(item.nativeSymbol, `native icon ${index} symbol`),
      };
    }),
    services: array(root.services, "native services").map((value, index) => {
      const item = record(value, `native service ${index}`);
      return {
        serviceId: requiredString(item.serviceId, `native service ${index} id`),
        nativePortId: requiredString(item.nativePortId, `native service ${index} port`),
        profiles: strings(item.profiles, `native service ${index} profiles`),
        inputPorts: strings(item.inputPorts, `native service ${index} inputs`),
        outputPorts: strings(item.outputPorts, `native service ${index} outputs`),
      };
    }),
    finiteValues: array(root.finiteValues, "native finite values").map((value, index) => {
      const item = record(value, `native finite value ${index}`);
      return {
        id: requiredString(item.id, `native finite value ${index} id`),
        values: strings(item.values, `native finite value ${index} values`),
      };
    }),
  };
}

function record(value: unknown, owner: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${owner} must be an object`);
  }
  return value as Record<string, unknown>;
}
function array(value: unknown, owner: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${owner} must be an array`);
  return value;
}
function strings(value: unknown, owner: string): readonly string[] {
  return array(value, owner).map((item, index) => requiredString(item, `${owner} ${index}`));
}
function requiredString(value: unknown, owner: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${owner} must be nonblank`);
  return value;
}
