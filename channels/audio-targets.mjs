/**
 * WHAT: Resolves the Discord channels the phone may address: the primary target, the configured extras, then every
 * other channel the fleet maps to a pane. WHY: Mattias wants every pane selectable in TALK TO (2026-09-14), and a
 * bridge keeps the AUDIO_INBOX_TARGETS it started with, so the channel map in agents.yaml is the truth that stays current.
 */
export function phoneTargetChannels(discovery, agents = null) {
  const primary = String(discovery?.target || "").trim();
  const extra = Array.isArray(discovery?.targets) ? discovery.targets : [];
  const mapped = Object.values(agents || {}).flatMap((entry) =>
    entry?.discord && typeof entry.discord === "object" ? Object.keys(entry.discord) : []);
  const channels = [];
  for (const value of [primary, ...extra, ...mapped]) {
    const channel = String(value || "").trim();
    if (channel && !channels.includes(channel)) channels.push(channel);
  }
  return channels;
}

/**
 * WHAT: Resolves the phone-addressable panes: one entry per Discord channel the fleet maps to a pane, with the pane's
 * own label. WHY: The voice PWA and the Link connector must offer the SAME list; when only the PWA knew it, Link's
 * TALK TO stayed on the three ids in a Cloudflare variable (row 184, Mattias 2026-09-17: "man ska kunna välja alla
 * kanaler"). One function, so a pane added to agents.yaml appears in both without a second edit.
 */
export function phoneTargets(discovery, agents = null) {
  const primary = String(discovery?.target || "").trim();
  const targets = [];
  for (const channel of phoneTargetChannels(discovery, agents)) {
    const owner = paneForChannel(agents, channel);
    if (!owner) continue;
    const entry = agents?.[owner.name];
    targets.push({
      id: `${owner.name}:${owner.pane}`,
      label: entry?.panes?.[owner.pane]?.label || `${owner.name}:${owner.pane}`,
      kind: "agent",
      agent: owner.name,
      pane: owner.pane,
      audioTarget: channel,
      favorite: channel === primary,
    });
  }
  return targets;
}

/** WHAT: Resolves the agent pane that owns one Discord channel. WHY: Prevents each route from re-implementing the discord mapping lookup. */
export function paneForChannel(agents, channel) {
  for (const [name, entry] of Object.entries(agents || {})) {
    const mapping = entry?.discord;
    if (!mapping || typeof mapping !== "object" || !Object.hasOwn(mapping, channel)) continue;
    const pane = Number(mapping[channel]);
    // A malformed or out-of-range mapping is unowned, never a delivery hint.
    if (!Number.isInteger(pane) || pane < 0) continue;
    const panes = Array.isArray(entry?.panes) ? entry.panes.length : null;
    if (panes !== null && pane >= panes) continue;
    return { name, pane };
  }
  return null;
}
