// Durable effective model selection per configured pane.

import { normalizeClaudeModelName } from "./claude-model.mjs";

// Keep the historical key so existing Fable selections survive the upgrade.
// The JSONL watcher already populated this map from real turn usage.
/** WHAT: Names durable pane model state. WHY: Keeps existing watcher selections readable after recovery upgrades. */
export const PANE_MODEL_STATE_KEY = "watcher_last_model";

/** WHAT: Builds one pane model key. WHY: Keeps neighbouring pane selections isolated. */
export const paneModelKey = (name, pane) => `${name}:${Number(pane) || 0}`;

/** WHAT: Reads one pane model selection. WHY: Keeps malformed persisted values outside launch commands. */
export function paneModelSelection(state, name, pane) {
  const value = state?.get?.(PANE_MODEL_STATE_KEY, {})?.[paneModelKey(name, pane)];
  const model = String(value?.model || "").trim();
  if (!model || !/^[a-z0-9._\[\]-]+$/iu.test(model)) return null;
  const effort = value?.effort == null ? null : String(value.effort).trim().toLowerCase();
  return { model, effort };
}

/**
 * WHAT: Turns a statusline display name ("Opus 5", "Fable 5.1") into its launch id.
 * WHY: Prevents display names from diverging from the launch identity used by recovery and model-change detection.
 */
export function launchModelId(model) {
  const raw = String(model || "").trim();
  if (!/\s/u.test(raw)) return raw;
  const spoken = normalizeClaudeModelName(raw);
  return spoken.ok ? spoken.model : raw;
}

/** WHAT: Stores one pane model selection. WHY: Keeps crash recovery on the operator-selected model. */
export function setPaneModelSelection(state, name, pane, model, effort = null) {
  const normalized = launchModelId(model);
  if (!/^[a-z0-9._\[\]-]+$/iu.test(normalized)) {
    throw new Error(`invalid pane model: ${model}`);
  }
  const map = { ...(state?.get?.(PANE_MODEL_STATE_KEY, {}) || {}) };
  map[paneModelKey(name, pane)] = {
    model: normalized,
    effort: effort == null ? null : String(effort).trim().toLowerCase(),
  };
  state.set(PANE_MODEL_STATE_KEY, map);
  return map;
}
