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
    agents.set(name, {
      dir: expandTilde(config.dir),
      panes: config.panes ?? config.claude ?? 1,
      services: config.services ?? [],
      shells: config.shells ?? 0,
      layout: config.layout ?? (config.services?.length || config.shells ? "main-vertical" : undefined),
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
 */
export function generateAgentsYaml(agents, channelMap, agentIds) {
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

    // Panes: coding agents first, then services, then shells
    const panes = [];
    for (let i = 0; i < config.panes; i++) {
      const pane = { name: i === 0 ? "claude" : `claude-${i + 1}`, cmd: DEFAULT_AGENT_CMD };
      panes.push(pane);
    }
    for (let i = 0; i < config.services.length; i++) {
      panes.push({ name: `service-${i + 1}`, cmd: config.services[i] });
    }
    for (let i = 0; i < config.shells; i++) {
      panes.push({ name: `shell-${i + 1}`, cmd: "bash" });
    }
    entry.panes = panes;

    result[name] = entry;
  }

  return "# Auto-generated by agentmux /sync. Do not edit manually.\n" + yaml.dump(result, { lineWidth: -1, quotingType: '"' });
}
