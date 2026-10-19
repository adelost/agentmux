import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import yaml from "js-yaml";
import { parseConfig, regenerateAgentsYaml } from "../sync.mjs";
import { runtimeStatePath } from "./runtime-defaults.mjs";
import { sourceCodingPaneSlots, sourcePaneChannelName } from "./source-pane-plan.mjs";
import { createState } from "./state.mjs";

/** WHAT: Reads the channel per pane name that the last /sync recorded. WHY: That record outlives every regeneration of the generated file. */
function syncedChannelsAt(statePath) {
  try { return createState(statePath).get("sync", {})?.channels || {}; }
  catch (error) {
    console.warn(`[config] cannot read the /sync record in ${statePath}: ${error.message}`);
    return {};
  }
}

/**
 * WHAT: Gives a source pane without a channel the one the last /sync bound to it.
 * WHY: Regeneration carries bindings only from the previous generated file, so one run
 * from a source without a pane lost its channel for good (#sandman-0, 2026-10-19).
 * A pane that has a channel keeps it, and no channel is bound twice.
 */
function restoreLostChannels(sourceYaml, existingYaml, syncedChannels) {
  const loaded = existingYaml ? yaml.load(existingYaml) : null;
  const existing = loaded && typeof loaded === "object" ? loaded : {};
  const bound = new Set(Object.values(existing).flatMap((entry) => Object.keys(entry?.discord || {})));
  const restored = [];
  for (const [name, config] of parseConfig(sourceYaml).agents) {
    const discord = { ...existing[name]?.discord };
    const boundPanes = new Set(Object.values(discord).map(Number));
    let added = false;
    for (const { pane } of sourceCodingPaneSlots(config)) {
      const channel = sourcePaneChannelName(name, pane, config);
      const channelId = syncedChannels[channel] ? String(syncedChannels[channel]) : null;
      if (!channelId || boundPanes.has(pane) || bound.has(channelId)) continue;
      discord[channelId] = pane;
      bound.add(channelId);
      restored.push(channel);
      added = true;
    }
    if (added) existing[name] = { ...existing[name], discord };
  }
  return { existingYaml: restored.length ? yaml.dump(existing) : existingYaml, restored };
}

/**
 * WHAT: Builds one generated pane config from the user-owned source file.
 * WHY: Prevents CLI, headless broker, and Discord from reading different fleet truths.
 */
export function materializeRuntimeConfig({ sourcePath, generatedPath, statePath = runtimeStatePath() }) {
  if (!existsSync(sourcePath)) throw new Error(`agentmux.yaml not found at ${sourcePath}`);
  const source = readFileSync(sourcePath, "utf8");
  const existing = existsSync(generatedPath) ? readFileSync(generatedPath, "utf8") : null;
  const { existingYaml, restored } = restoreLostChannels(source, existing, syncedChannelsAt(statePath));
  const next = regenerateAgentsYaml(source, existingYaml);
  if (next === existing) return { path: generatedPath, changed: false, restored };
  mkdirSync(dirname(generatedPath), { recursive: true, mode: 0o700 });
  const temporary = `${generatedPath}.${process.pid}.tmp`;
  writeFileSync(temporary, next, { mode: 0o600 });
  renameSync(temporary, generatedPath);
  chmodSync(generatedPath, 0o600);
  if (restored.length) {
    console.warn(`[config] ${generatedPath} had lost ${restored.length} channel(s); restored from the last /sync: #${restored.join(", #")}`);
  }
  return { path: generatedPath, changed: true, restored };
}

/**
 * WHAT: Resolves a generated config from source or an explicit legacy file.
 * WHY: Keeps upgraded installations working while new installs use one source truth.
 */
export function ensureRuntimeConfig({ sourcePath, generatedPath, statePath }) {
  if (existsSync(sourcePath)) return materializeRuntimeConfig({ sourcePath, generatedPath, statePath });
  if (existsSync(generatedPath)) return { path: generatedPath, changed: false, legacy: true };
  throw new Error(`agentmux.yaml not found at ${sourcePath}`);
}
