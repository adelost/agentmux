// Durable effective model selection per configured pane.

import { isRequestedClaudeModel, normalizeClaudeModelName } from "./claude-model.mjs";

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

/** WHAT: Stores one observed pane model reading. WHY: Keeps a missing or cut-short effort from replacing the one restarts launch (E93). */
export function recordPaneModelReading(state, name, pane, model, effort = null) {
  const prev = paneModelSelection(state, name, pane);
  const ran = prev?.model === launchModelId(model) ? prev.effort : null;
  const read = effort == null ? null : String(effort).trim().toLowerCase();
  // a line cut at the pane's edge shows only the front ("m" of max); no effort Claude accepts is the front of another
  const cut = read != null && ran != null && read !== ran && ran.startsWith(read);
  setPaneModelSelection(state, name, pane, model, read == null || cut ? ran : read);
  return paneModelSelection(state, name, pane);
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

// amux model marks the switch it is making before it sends /model, so the
// model-watch never reads the pane's own switch as a silent downgrade. On
// 2026-10-19 claw:2 was stopped and parked by its own switch and lost 33 min.
// A switch amux could not verify stays marked: Claude Code may still run it,
// as it did on skyvw:2 a moment after amux gave up.
const PANE_MODEL_SWITCH_KEY = "pane_model_switch_v1";
// A switch whose mark outlives this died with its process; a real downgrade must alarm again.
// amux model gives a switch it could not verify a longer life of its own.
const PANE_MODEL_SWITCH_MS = 2 * 60_000;

/** WHAT: Stores the model switch amux is making on one pane. WHY: Keeps the model-watch from alarming on a switch made on purpose. */
export function beginPaneModelSwitch(state, name, pane, { from, to, keep = null, lifeMs = PANE_MODEL_SWITCH_MS }, now = Date.now()) {
  const map = { ...(state.get(PANE_MODEL_SWITCH_KEY, {}) || {}) };
  map[paneModelKey(name, pane)] = { from, to, keep, at: now, until: now + lifeMs };
  state.set(PANE_MODEL_SWITCH_KEY, map);
}

/** WHAT: Stores that one pane's model switch is over. WHY: Keeps a later real downgrade from passing as the finished switch. */
export function endPaneModelSwitch(state, name, pane) {
  const map = { ...(state.get(PANE_MODEL_SWITCH_KEY, {}) || {}) };
  delete map[paneModelKey(name, pane)];
  state.set(PANE_MODEL_SWITCH_KEY, map);
}

const markedSwitch = (state, name, pane, now) => {
  const change = state?.get?.(PANE_MODEL_SWITCH_KEY, {})?.[paneModelKey(name, pane)];
  return change && now < (change.until ?? change.at + PANE_MODEL_SWITCH_MS) ? change : null;
};

/** WHAT: Checks whether a reading shows the old or new model of a switch in progress. WHY: Keeps either side of the switch from reading as a downgrade. */
export function isPaneModelSwitchReading(state, name, pane, reading, now = Date.now()) {
  const change = markedSwitch(state, name, pane, now);
  if (!change) return false;
  const running = launchModelId(reading?.model);
  return [change.from, change.to].some((model) => isRequestedClaudeModel(running, model));
}

/** WHAT: Returns the marked switch a reading shows has landed. WHY: Keeps a switch that lands after amux model gave up from staying half done. */
export function landedPaneModelSwitch(state, name, pane, reading, now = Date.now()) {
  const change = markedSwitch(state, name, pane, now);
  return change && isRequestedClaudeModel(launchModelId(reading?.model), change.to) ? change : null;
}
