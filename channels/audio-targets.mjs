/** WHAT: Resolves the Discord channels the phone may address. WHY: Keeps every audio route on the same explicit target truth. */
export function phoneTargetChannels(discovery) {
  const primary = String(discovery?.target || "").trim();
  const extra = Array.isArray(discovery?.targets) ? discovery.targets : [];
  const channels = [];
  for (const value of [primary, ...extra]) {
    const channel = String(value || "").trim();
    if (channel && !channels.includes(channel)) channels.push(channel);
  }
  return channels;
}

/** WHAT: Resolves the agent pane that owns one Discord channel. WHY: Prevents each route from re-implementing the discord mapping lookup. */
export function paneForChannel(agents, channel) {
  for (const [name, entry] of Object.entries(agents || {})) {
    const mapping = entry?.discord;
    if (mapping && typeof mapping === "object" && Object.hasOwn(mapping, channel)) {
      return { name, pane: Number(mapping[channel]) };
    }
  }
  return null;
}
