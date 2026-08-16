import { parsePaneOverride } from "../lib.mjs";

/** WHAT: Resolves one live Discord message to its configured pane unless its text explicitly selects another. WHY: Prevents parsePane's legacy zero fallback from erasing nonzero channel mappings. */
export function resolveConfiguredInboundTarget(mapping, text) {
  if (!mapping) return null;
  const override = parsePaneOverride(String(text || ""));
  return {
    agentName: mapping.name,
    pane: override?.pane ?? mapping.pane ?? 0,
    dir: mapping.dir || null,
  };
}

/** WHAT: Returns one persisted Discord target overlaid on its live channel mapping. WHY: Keeps retry routing stable without dropping runtime-only mapping fields. */
export function mergeInboundTarget(liveMapping, persistedTarget) {
  if (!liveMapping && !persistedTarget) return null;
  if (!persistedTarget) return liveMapping;
  return {
    ...(liveMapping || {}),
    name: persistedTarget.agentName,
    pane: persistedTarget.pane,
    dir: persistedTarget.dir || liveMapping?.dir || null,
  };
}
