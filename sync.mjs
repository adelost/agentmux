// Sync logic: parse agentmux.yaml, generate channel names, build sync plans,
// generate legacy agents.yaml. Pure functions, no Discord API calls.

import yaml from "js-yaml";
import { randomUUID } from "crypto";
import { resolveTmuxLayout } from "./core/layout.mjs";
import { resolveClaudeModel } from "./core/claude-model.mjs";
import {
  CLAUDE_AUTONOMOUS_FLAGS,
  CODEX_AUTONOMOUS_FLAGS,
  KIMI_AUTONOMOUS_FLAGS,
} from "./core/execution-safety.mjs";

const DEFAULT_AGENT_CMD = `claude --continue ${CLAUDE_AUTONOMOUS_FLAGS} --model ${resolveClaudeModel()}`;
// Never `codex resume --last`: it resumes the globally most-recent rollout, not
// this pane's own, so a pane launched from generated config can attach to
// another live pane's session — two writers, interleaved model/context (the
// skydive model-override incident). This generated command is only a pane-type
// descriptor; startCodex resolves and resumes the exact pane-owned session.
// A bare launch is allowed only for a profile's first explicit bootstrap.
const DEFAULT_CODEX_CMD = `codex ${CODEX_AUTONOMOUS_FLAGS}`;
const DEFAULT_KIMI_MODEL = "kimi-code/k3";
const DEFAULT_KIMI_CMD = `${process.env.HOME}/.kimi-code/bin/kimi --model ${DEFAULT_KIMI_MODEL} ${KIMI_AUTONOMOUS_FLAGS}`;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KIMI_MODEL_PATTERN = /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)?$/iu;

function paneCount(value, label, agentName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`agentmux.yaml: agent '${agentName}' has invalid ${label} count`);
  }
  return value;
}

/** Expand ~ to $HOME in paths */
export function expandTilde(p) {
  if (p.startsWith("~/")) return p.replace("~", process.env.HOME);
  return p;
}

/** WHAT: Parses source configuration. WHY: Keeps generated pane metadata normalized across engines. */
export function parseConfig(yamlContent) {
  const doc = yaml.load(yamlContent);
  if (!doc?.guild) throw new Error("agentmux.yaml: 'guild' is required");
  if (!doc?.agents || typeof doc.agents !== "object") throw new Error("agentmux.yaml: 'agents' section is required");

  const agents = new Map();
  for (const [name, config] of Object.entries(doc.agents)) {
    if (!config?.dir) throw new Error(`agentmux.yaml: agent '${name}' needs a 'dir'`);
    const backend = config.backend ?? "tmux";
    if (!["tmux", "native"].includes(backend)) {
      throw new Error(`agentmux.yaml: agent '${name}' has unknown backend '${backend}'`);
    }
    if (backend === "native" && (config.shells ?? 0) > 0) {
      throw new Error(`agentmux.yaml: native agent '${name}' cannot define tmux shell panes`);
    }
    if (config.interAgentSend !== undefined && typeof config.interAgentSend !== "boolean") {
      throw new Error(`agentmux.yaml: agent '${name}' has invalid interAgentSend policy`);
    }
    // `labels` keyed by absolute pane index (Claude, Codex, Kimi, then
    // service panes, then shells). Coerce keys to numbers so writers
    // can use either numeric or string keys in yaml.
    //
    // Returns `null` when the source has no labels block at all, so
    // downstream can distinguish "user hasn't opted into label management
    // for this agent" (null = fall back to existing agents.yaml) from
    // "user has opted in but cleared all labels" (empty {} = authoritative
    // empty). Without this distinction, clearing a label via `amux label
    // --clear` would resurrect it from the previously-regenerated
    // agents.yaml on the next regen.
    let labels = null;
    if (config.labels && typeof config.labels === "object") {
      labels = {};
      for (const [k, v] of Object.entries(config.labels)) {
        const idx = Number(k);
        if (Number.isInteger(idx) && typeof v === "string" && v.trim()) {
          labels[idx] = v;
        }
      }
    }
    // Pane count breakdown:
    //   - claudeCount: claude-cli panes, indices [0, claudeCount)
    //   - codexCount:  codex-cli panes, indices [claudeCount, panes)
    //   - kimiCount:   Kimi Code panes after Codex
    //   - panes:       total agent panes, excluding services/shells
    // Discord suffixes make non-Claude engines explicit at a glance.
    const claudeCount = paneCount(
      config.panes ?? config.claude ?? (config.codex || config.kimi ? 0 : 1),
      "claude",
      name,
    );
    const codexCount = paneCount(config.codex ?? 0, "codex", name);
    const kimiCount = paneCount(config.kimi ?? 0, "kimi", name);
    const kimiModel = config.kimiModel || DEFAULT_KIMI_MODEL;
    if (!KIMI_MODEL_PATTERN.test(kimiModel)) {
      throw new Error(`agentmux.yaml: agent '${name}' has invalid kimiModel '${kimiModel}'`);
    }
    const codingPaneCount = claudeCount + codexCount + kimiCount;
    if (backend === "native" && kimiCount > 0) {
      throw new Error(`agentmux.yaml: native agent '${name}' cannot define Kimi tmux panes`);
    }
    if (backend === "native" && codingPaneCount < 1) {
      throw new Error(`agentmux.yaml: native agent '${name}' needs at least one Claude or Codex pane`);
    }
    const nativeAgentIds = {};
    if (config.nativeAgentIds !== undefined) {
      if (backend !== "native" || !config.nativeAgentIds || typeof config.nativeAgentIds !== "object"
          || Array.isArray(config.nativeAgentIds)) {
        throw new Error(`agentmux.yaml: agent '${name}' has invalid nativeAgentIds`);
      }
      for (const [rawIndex, rawId] of Object.entries(config.nativeAgentIds)) {
        const index = Number(rawIndex);
        if (!Number.isSafeInteger(index) || index < 0 || index >= codingPaneCount
            || typeof rawId !== "string" || !UUID_PATTERN.test(rawId)) {
          throw new Error(`agentmux.yaml: agent '${name}' has invalid nativeAgentIds entry '${rawIndex}'`);
        }
        nativeAgentIds[index] = rawId;
      }
    }
    agents.set(name, {
      dir: expandTilde(config.dir),
      panes: codingPaneCount,
      claudeCount,
      codexCount,
      kimiCount,
      services: config.services ?? [],
      shells: config.shells ?? 0,
      layout: resolveTmuxLayout(config.layout),
      labels,
      interAgentSend: config.interAgentSend,
      backend,
      runtimeUrl: backend === "native"
        ? String(config.runtime || "http://127.0.0.1:8811").replace(/\/+$/, "")
        : null,
      claudeModel: config.claudeModel || null,
      codexModel: config.codexModel || null,
      kimiModel,
      effort: config.effort || null,
      nativeAgentIds,
    });
  }

  return {
    guild: String(doc.guild),
    category: doc.category || "Agents",
    agents,
    // `search.roots` (amux search corpora) lives in the SOURCE yaml so it
    // survives every regeneration of agents.yaml. A hand-added section in
    // the generated file dies on the next /sync or `amux label`.
    search: doc.search ?? null,
  };
}

/**
 * Build the desired channel name for a pane, applying the engine suffix
 * when the pane index lands outside the Claude range.
 */
function paneDialect(config, pane) {
  const claudeCount = config.claudeCount ?? config.panes ?? 0;
  const codexCount = config.codexCount ?? Math.max(0, (config.panes ?? 0) - claudeCount);
  if (pane < claudeCount) return "claude";
  if (pane < claudeCount + codexCount) return "codex";
  return "kimi";
}

function paneChannelName(name, pane, config) {
  const dialect = paneDialect(config, pane);
  return dialect === "claude" ? `${name}-${pane}` : `${name}-${pane}-${dialect}`;
}

/** WHAT: Builds pane channel names. WHY: Keeps engine suffixes stable across Discord syncs. */
export function generateChannelNames(agents) {
  const result = [];
  const sortedNames = [...agents.keys()].sort();

  for (const name of sortedNames) {
    const config = agents.get(name);
    const { panes } = config;
    for (let i = 0; i < panes; i++) {
      const dialect = paneDialect(config, i);
      result.push({
        agentName: name,
        channelName: paneChannelName(name, i, config),
        pane: i,
        dialect,
      });
    }
  }
  return result;
}

/** WHAT: Parses pane channel names. WHY: Keeps legacy migrations separate from engine suffix parsing. */
export function classifyAgentChannel(channelName, agentNames, existingNamesLower) {
  const lower = channelName.toLowerCase();
  // Longest first so "api-proxy" wins over "api" when matching "api-proxy-0".
  const sorted = [...agentNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const nameLower = name.toLowerCase();
    if (lower === nameLower) {
      return { agentName: name, pane: 0, format: "legacy", dialect: "claude" };
    }
    const prefix = nameLower + "-";
    if (!lower.startsWith(prefix)) continue;
    const rest = lower.slice(prefix.length);
    // Match plain `{agent}-{N}` (claude), `-codex`, or `-kimi`.
    const match = rest.match(/^(\d+)(?:-(codex|kimi))?$/);
    if (!match) continue;
    const n = parseInt(match[1], 10);
    const dialect = match[2] || "claude";
    const isLegacyAgent = existingNamesLower.has(nameLower);
    if (isLegacyAgent && n >= 2 && dialect === "claude") {
      return { agentName: name, pane: n - 1, format: "legacy", dialect };
    }
    return { agentName: name, pane: n, format: "new", dialect };
  }
  return null;
}

/** WHAT: Collects existing pane channels. WHY: Keeps orphan detection separate from migration planning. */
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

/** WHAT: Builds channel migration operations. WHY: Keeps renames and creates deterministic across retries. */
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
      const target = paneChannelName(name, p, config);
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

/** WHAT: Builds a channel sync plan. WHY: Keeps create and orphan operations deterministic. */
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

/** WHAT: Builds runtime pane configuration. WHY: Keeps labels and channel bindings stable across regeneration. */
export function generateAgentsYaml(agents, channelMap, agentIds, existingYaml = null, search = null) {
  // `search:` is emitted first: it is fleet config, not an agent entry.
  // Consumers enumerate agents by filtering on `dir`, so the key is inert
  // for them; loadSearchRoots reads it from this generated file.
  const result = search ? { search } : {};
  const sortedNames = [...agents.keys()].sort();

  for (const name of sortedNames) {
    const config = agents.get(name);
    const entry = {
      dir: config.dir,
      id: agentIds.get(name) || randomUUID(),
    };
    if (typeof config.interAgentSend === "boolean") entry.interAgentSend = config.interAgentSend;
    if (config.backend === "native") {
      entry.backend = "native";
      entry.runtimeUrl = config.runtimeUrl;
    }

    // Discord channel mapping. Non-Claude suffixes are part of the name.
    const claudeCount = config.claudeCount ?? config.panes;
    const discord = {};
    for (let i = 0; i < config.panes; i++) {
      const channelName = paneChannelName(name, i, config);
      const channelId = channelMap.get(channelName);
      if (channelId) discord[channelId] = i;
    }
    if (Object.keys(discord).length) entry.discord = discord;

    // Layout
    if (config.layout) entry.layout = config.layout;

    // Panes: coding agents first, then services, then shells.
    // Label resolution:
    //   - config.labels === null  → source has no labels block; fall back
    //                                to existingYaml preservation (legacy
    //                                upgrade path)
    //   - config.labels === {...} → source has opted in; authoritative.
    //                                Missing indices = no label (do NOT
    //                                resurrect old labels from generated
    //                                agents.yaml — that would defeat --clear)
    const existingPanes = existingYaml?.[name]?.panes || [];
    const sourceLabels = config.labels;
    const labelFor = sourceLabels !== null && sourceLabels !== undefined
      ? (idx) => sourceLabels[idx]
      : (idx) => existingPanes[idx]?.label;

    const panes = [];
    let paneIdx = 0;
    for (let i = 0; i < claudeCount; i++) {
      const pane = config.backend === "native"
        ? {
            name: i === 0 ? "claude" : `claude-${i + 1}`,
            cmd: "native:claude",
            engine: "claude",
            ...(config.claudeModel ? { model: config.claudeModel } : {}),
            ...(config.effort ? { effort: config.effort } : {}),
            ...(config.nativeAgentIds?.[paneIdx] ? { nativeAgentId: config.nativeAgentIds[paneIdx] } : {}),
          }
        : { name: i === 0 ? "claude" : `claude-${i + 1}`, cmd: DEFAULT_AGENT_CMD };
      const label = labelFor(paneIdx);
      if (label) pane.label = label;
      panes.push(pane);
      paneIdx++;
    }
    const codexCount = config.codexCount ?? Math.max(0, config.panes - claudeCount);
    for (let i = 0; i < codexCount; i++) {
      const pane = config.backend === "native"
        ? {
            name: i === 0 ? "codex" : `codex-${i + 1}`,
            cmd: "native:codex",
            engine: "codex",
            ...(config.codexModel ? { model: config.codexModel } : {}),
            ...(config.effort ? { effort: config.effort } : {}),
            ...(config.nativeAgentIds?.[paneIdx] ? { nativeAgentId: config.nativeAgentIds[paneIdx] } : {}),
          }
        : { name: i === 0 ? "codex" : `codex-${i + 1}`, cmd: DEFAULT_CODEX_CMD };
      const label = labelFor(paneIdx);
      if (label) pane.label = label;
      panes.push(pane);
      paneIdx++;
    }
    const kimiCount = config.kimiCount ?? 0;
    for (let i = 0; i < kimiCount; i++) {
      const model = config.kimiModel || DEFAULT_KIMI_MODEL;
      const pane = {
        name: i === 0 ? "kimi" : `kimi-${i + 1}`,
        cmd: DEFAULT_KIMI_CMD.replace(`--model ${DEFAULT_KIMI_MODEL}`, `--model ${model}`),
        engine: "kimi",
        model,
      };
      const label = labelFor(paneIdx);
      if (label) pane.label = label;
      panes.push(pane);
      paneIdx++;
    }
    // Native services are process-supervised outside tmux and therefore do
    // not consume an addressable agent pane. Interactive shell panes have no
    // native equivalent and are rejected above instead of disappearing.
    if (config.backend !== "native") {
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
    }
    entry.panes = panes;

    result[name] = entry;
  }

  return "# Auto-generated by agentmux /sync. Do not edit manually.\n" + yaml.dump(result, { lineWidth: -1, quotingType: '"' });
}

/** WHAT: Builds local runtime configuration. WHY: Keeps Discord bindings unchanged during local edits. */
export function regenerateAgentsYaml(sourceYaml, existingAgentsYaml) {
  const { agents, search } = parseConfig(sourceYaml);
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
        const config = agents.get(name);
        if (!config) continue;
        for (const [channelId, paneIdx] of Object.entries(entry.discord)) {
          const idx = Number(paneIdx);
          channelMap.set(paneChannelName(name, idx, config), String(channelId));
        }
      }
    }
  }

  return generateAgentsYaml(agents, channelMap, agentIds, existing, search);
}
