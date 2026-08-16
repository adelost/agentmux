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
