// Sync logic: parse agentmux.yaml, generate channel names, build sync plans,
// generate legacy agents.yaml. Pure functions, no Discord API calls.

import yaml from "js-yaml";
import { randomUUID } from "crypto";

const DEFAULT_AGENT_CMD = "claude --continue --dangerously-skip-permissions";

/** Expand ~ to $HOME in paths */
export function expandTilde(p) {
  if (p.startsWith("~/")) return p.replace("~", process.env.HOME);
  return p;
}

/**
 * Parse agentmux.yaml content into normalized config.
 * @returns {{ guild: string, category: string, agents: Map<string, { dir, claude, services, shells, layout }> }}
 */
export function parseConfig(yamlContent) {
  const doc = yaml.load(yamlContent);
  if (!doc?.guild) throw new Error("agentmux.yaml: 'guild' is required");
  if (!doc?.agents || typeof doc.agents !== "object") throw new Error("agentmux.yaml: 'agents' section is required");

  const agents = new Map();
  for (const [name, config] of Object.entries(doc.agents)) {
    if (!config?.dir) throw new Error(`agentmux.yaml: agent '${name}' needs a 'dir'`);
    // `labels` is keyed by absolute pane index (0 = first claude, then
    // service panes after the claude count, then shells). Coerce keys to
    // numbers so writers can use either numeric or string keys in yaml.
    const labels = {};
    if (config.labels && typeof config.labels === "object") {
      for (const [k, v] of Object.entries(config.labels)) {
        const idx = Number(k);
        if (Number.isInteger(idx) && typeof v === "string" && v.trim()) {
          labels[idx] = v;
        }
      }
    }
    agents.set(name, {
      dir: expandTilde(config.dir),
      panes: config.panes ?? config.claude ?? 1,
      services: config.services ?? [],
      shells: config.shells ?? 0,
      layout: config.layout ?? (config.services?.length || config.shells ? "main-vertical" : undefined),
      labels,
    });
  }

  return {
    guild: String(doc.guild),
    category: doc.category || "Agents",
    agents,
  };
}

/**
 * Generate Discord channel names from agent config.
 * Returns a flat, alphabetically sorted list of { agentName, channelName, pane }.
 * Naming: #agent-0 (pane 0), #agent-1 (pane 1), #agent-2 (pane 2)... matches tmux pane index.
 */
export function generateChannelNames(agents) {
  const result = [];
  const sortedNames = [...agents.keys()].sort();

  for (const name of sortedNames) {
    const { panes } = agents.get(name);
    for (let i = 0; i < panes; i++) {
      result.push({
        agentName: name,
        channelName: `${name}-${i}`,
        pane: i,
      });
    }
  }
  return result;
}

/**
 * Classify a Discord channel name against known agent names.
 * Legacy format: `{agent}` = pane 0, `{agent}-N` (N>=2) = pane N-1.
 * New format: `{agent}-N` = pane N (0-indexed).
 *
 * Legacy is detected per-agent by the presence of a bare `{agent}` channel in the guild.
 * @returns {{ agentName, pane, format: "new"|"legacy" } | null}
 */
export function classifyAgentChannel(channelName, agentNames, existingNamesLower) {
  const lower = channelName.toLowerCase();
  // Longest first so "api-proxy" wins over "api" when matching "api-proxy-0".
  const sorted = [...agentNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const nameLower = name.toLowerCase();
    if (lower === nameLower) {
      return { agentName: name, pane: 0, format: "legacy" };
    }
    const prefix = nameLower + "-";
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    if (!/^\d+$/.test(rest)) continue;
    const n = parseInt(rest, 10);
    const isLegacyAgent = existingNamesLower.has(nameLower);
    if (isLegacyAgent && n >= 2) {
      return { agentName: name, pane: n - 1, format: "legacy" };
    }
    return { agentName: name, pane: n, format: "new" };
  }
  return null;
}

/**
 * Group existing Discord channels by the agent they belong to.
 * @param {Array<{ name, id, parentId }>} existing
 * @param {string[]} agentNames
 * @returns {{ byAgent: Map<string, Array>, orphans: Array }}
 */
export function classifyExistingChannels(existing, agentNames) {
  const existingNamesLower = new Set(existing.map((ch) => ch.name.toLowerCase()));
  const byAgent = new Map();
  const orphans = [];
  for (const ch of existing) {
    const info = classifyAgentChannel(ch.name, agentNames, existingNamesLower);
    if (!info) { orphans.push(ch); continue; }
    const list = byAgent.get(info.agentName) ?? [];
    list.push({ ...ch, pane: info.pane, format: info.format });
    byAgent.set(info.agentName, list);
  }
  return { byAgent, orphans };
}

/**
 * Build a migration-aware sync plan. For each agent, figure out which existing
 * channels to rename, which to create, and which are extras beyond configured panes.
 *
 * @param {Map<string, { panes: number }>} agents
 * @param {Array<{ name, id, parentId }>} existingChannels - all text channels in guild
 * @returns {{ renames, creates, keep, extras, orphans }}
 *   renames:  [{ id, from, to, agentName, pane }]      - legacy → new name
 *   creates:  [{ agentName, channelName, pane }]       - missing panes
 *   keep:     [{ id, channelName, agentName, pane }]   - already on new name
 *   extras:   [{ id, name, agentName, pane }]          - claimed but beyond configured panes
 *   orphans:  [{ name, id, parentId }]                 - unrelated to any agent
 */
export function buildMigrationPlan(agents, existingChannels) {
  const agentNames = [...agents.keys()];
  const { byAgent, orphans } = classifyExistingChannels(existingChannels, agentNames);

  const renames = [];
  const creates = [];
  const keep = [];
  const extras = [];

  for (const name of agentNames) {
    const config = agents.get(name);
    const claimed = byAgent.get(name) ?? [];

    // If multiple channels claim the same pane, keep first-seen; rest are extras.
    const byPane = new Map();
    for (const c of claimed) {
      if (c.pane >= config.panes) { extras.push(c); continue; }
      if (byPane.has(c.pane)) { extras.push(c); continue; }
      byPane.set(c.pane, c);
    }

    for (let p = 0; p < config.panes; p++) {
      const target = `${name}-${p}`;
      const ch = byPane.get(p);
      if (!ch) {
        creates.push({ agentName: name, channelName: target, pane: p });
      } else if (ch.name === target) {
        keep.push({ id: ch.id, channelName: ch.name, agentName: name, pane: p, parentId: ch.parentId });
      } else {
        renames.push({ id: ch.id, from: ch.name, to: target, agentName: name, pane: p, parentId: ch.parentId });
      }
    }
  }

  return { renames, creates, keep, extras, orphans };
}

/**
 * Build a sync plan by comparing desired channels with existing Discord channels.
 * @param {Array<{ agentName, channelName, pane }>} desired
 * @param {Array<{ name: string, id: string }>} existing - channels in the target category
 * @returns {{ toCreate: Array, existing: Array, orphaned: Array }}
 */
export function buildSyncPlan(desired, existing) {
  const existingByName = new Map(existing.map((ch) => [ch.name.toLowerCase(), ch]));
  const desiredNames = new Set(desired.map((d) => d.channelName.toLowerCase()));

  const toCreate = [];
  const matched = [];

  for (const d of desired) {
    const found = existingByName.get(d.channelName.toLowerCase());
    if (found) {
      matched.push({ ...d, id: found.id });
    } else {
      toCreate.push(d);
    }
  }

  const orphaned = existing.filter((ch) => !desiredNames.has(ch.name.toLowerCase()));

  return { toCreate, existing: matched, orphaned };
}

/**
 * Generate legacy agents.yaml content for backward compat with `agent` CLI.
 * @param {Map<string, object>} agents - parsed agent configs
 * @param {Map<string, string>} channelMap - channelName → channelId
 * @param {Map<string, string>} agentIds - agentName → UUID
 * @param {object} [existingYaml] - previous agents.yaml parsed, for
 *   preserving user-set per-pane fields (label) across regenerations.
 *   agentmux.yaml (the sync source) has no slot for labels, so they
 *   only live in agents.yaml itself; without this merge they'd be
 *   wiped every /sync.
 */
export function generateAgentsYaml(agents, channelMap, agentIds, existingYaml = null) {
  const result = {};
  const sortedNames = [...agents.keys()].sort();

  for (const name of sortedNames) {
    const config = agents.get(name);
    const entry = {
      dir: config.dir,
      id: agentIds.get(name) || randomUUID(),
    };

    // Discord channel mapping (only claude panes)
    const discord = {};
    for (let i = 0; i < config.panes; i++) {
      const channelName = `${name}-${i}`;
      const channelId = channelMap.get(channelName);
      if (channelId) discord[channelId] = i;
    }
    if (Object.keys(discord).length) entry.discord = discord;

    // Layout
    if (config.layout) entry.layout = config.layout;

    // Panes: coding agents first, then services, then shells.
    // Label resolution: source (agentmux.yaml config.labels) wins. Fallback
    // to existingYaml's agents.yaml preservation for agents whose source
    // config predates labels (zero-friction upgrade path).
    const existingPanes = existingYaml?.[name]?.panes || [];
    const sourceLabels = config.labels || {};
    const labelFor = (idx) => sourceLabels[idx] ?? existingPanes[idx]?.label;

    const panes = [];
    let paneIdx = 0;
    for (let i = 0; i < config.panes; i++) {
      const pane = { name: i === 0 ? "claude" : `claude-${i + 1}`, cmd: DEFAULT_AGENT_CMD };
      const label = labelFor(paneIdx);
      if (label) pane.label = label;
      panes.push(pane);
      paneIdx++;
    }
    for (let i = 0; i < config.services.length; i++) {
      const pane = { name: `service-${i + 1}`, cmd: config.services[i] };
      const label = labelFor(paneIdx);
      if (label) pane.label = label;
      panes.push(pane);
      paneIdx++;
    }
    for (let i = 0; i < config.shells; i++) {
      const pane = { name: `shell-${i + 1}`, cmd: "bash" };
      const label = labelFor(paneIdx);
      if (label) pane.label = label;
      panes.push(pane);
      paneIdx++;
    }
    entry.panes = panes;

    result[name] = entry;
  }

  return "# Auto-generated by agentmux /sync. Do not edit manually.\n" + yaml.dump(result, { lineWidth: -1, quotingType: '"' });
}

/**
 * Regenerate agents.yaml from agentmux.yaml without touching Discord.
 *
 * Used by local edits (e.g. `amux label`) to materialize changes without
 * requiring a full /sync (which needs the Discord bot online). The
 * channelMap and agentIds are carried over from the existing agents.yaml
 * so nothing about Discord bindings changes — we only rewrite the
 * per-agent pane metadata (dir, panes, labels, layout).
 *
 * @param {string} sourceYaml       - agentmux.yaml content (parsed as source)
 * @param {string|null} existingAgentsYaml - existing agents.yaml content, or null
 * @returns {string} regenerated agents.yaml content
 */
export function regenerateAgentsYaml(sourceYaml, existingAgentsYaml) {
  const { agents } = parseConfig(sourceYaml);
  const existing = existingAgentsYaml ? yaml.load(existingAgentsYaml) : null;

  // Carry over channelMap + agentIds from existing agents.yaml. If none
  // exists yet (first run), channels/IDs are empty; label changes still
  // land correctly — just Discord mapping stays absent until /sync runs.
  const channelMap = new Map();
  const agentIds = new Map();
  if (existing && typeof existing === "object") {
    for (const [name, entry] of Object.entries(existing)) {
      if (entry?.id) agentIds.set(name, entry.id);
      if (entry?.discord && typeof entry.discord === "object") {
        for (const [channelId, paneIdx] of Object.entries(entry.discord)) {
          channelMap.set(`${name}-${paneIdx}`, String(channelId));
        }
      }
    }
  }

  return generateAgentsYaml(agents, channelMap, agentIds, existing);
}
