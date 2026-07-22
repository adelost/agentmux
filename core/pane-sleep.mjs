// Conservative pane sleep policy and durable lifecycle state (T8/T10).
//
// This module owns decisions and receipts only. Pane writes remain in the CLI
// and delivery broker, both serialized by the delivery queue's session lease.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { jsonlEventsAfterCursor } from "./jsonl-append-cursor.mjs";

/** WHAT: Defines the durable sleep-record version. WHY: Keeps incompatible lifecycle state from being accepted silently. */
export const PANE_SLEEP_VERSION = 1;
/** WHAT: Defines the minimum idle window. WHY: Keeps short pauses from becoming sleep candidates. */
export const PANE_SLEEP_IDLE_MS = 24 * 60 * 60 * 1000;
/** WHAT: Defines valid lifecycle states. WHY: Keeps corrupt state from driving wake or sleep. */
export const PANE_SLEEP_STATES = new Set([
  "awake",
  "arming",
  "asleep",
  "wake_pending",
  "blocked",
]);

const MODAL_TRANSPORT_STATES = new Set(["foreign", "hidden", "drafted", "empty-busy"]);
const ROLLUP_KEY_BUCKET_MS = 30 * 60 * 1000;

function safeTargetPart(value) {
  return encodeURIComponent(String(value)).replaceAll("%", "_");
}

/** WHAT: Resolves the durable sleep-state directory. WHY: Keeps state location consistent across CLI and broker. */
export function paneSleepStateDir(home = homedir()) {
  return join(home, ".agentmux", "pane-sleep");
}

/** WHAT: Resolves one pane sleep record path. WHY: Keeps pane identities isolated on disk. */
export function paneSleepStatePath(agentName, pane, { rootDir = paneSleepStateDir() } = {}) {
  return join(rootDir, `${safeTargetPart(agentName)}--p${Number(pane) || 0}.json`);
}

/** WHAT: Reads and validates one sleep record. WHY: Keeps malformed state from authorizing a wake. */
export function readPaneSleepState(agentName, pane, options = {}) {
  try {
    const value = JSON.parse(readFileSync(paneSleepStatePath(agentName, pane, options), "utf8"));
    if (value?.version !== PANE_SLEEP_VERSION
        || value?.agentName !== String(agentName)
        || value?.pane !== Number(pane)
        || !PANE_SLEEP_STATES.has(value?.status)
        || !Number.isSafeInteger(value?.sleepGeneration)
        || value.sleepGeneration < 0) return null;
    return value;
  } catch {
    return null;
  }
}

/** WHAT: Checks and atomically stores one sleep record. WHY: Keeps crashes from leaving partial lifecycle state. */
export function writePaneSleepState(state, options = {}) {
  if (state?.version !== PANE_SLEEP_VERSION
      || !PANE_SLEEP_STATES.has(state?.status)
      || !Number.isSafeInteger(state?.sleepGeneration)
      || state.sleepGeneration < 0) {
    throw new Error("invalid pane sleep state");
  }
  const path = paneSleepStatePath(state.agentName, state.pane, options);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return state;
}

/** WHAT: Builds the next arming generation. WHY: Keeps repeated sleep attempts distinguishable across restarts. */
export function beginSleepState({
  previous = null,
  agentName,
  pane,
  sessionId,
  processGeneration,
  nowMs,
}) {
  if (!sessionId || !processGeneration || !Number.isFinite(Number(nowMs))) {
    throw new Error("sleep arming requires session, process generation, and time");
  }
  return {
    version: PANE_SLEEP_VERSION,
    agentName: String(agentName),
    pane: Number(pane),
    status: "arming",
    stage: "pre-compact",
    sleepGeneration: Number(previous?.sleepGeneration || 0) + 1,
    sessionId: String(sessionId),
    processGeneration: String(processGeneration),
    armedAt: Number(nowMs),
    updatedAt: Number(nowMs),
  };
}

/** WHAT: Stores a classified blocked transition. WHY: Keeps partial sleep attempts visible and non-retryable by accident. */
export function blockedSleepState(state, reason, nowMs) {
  return {
    ...state,
    status: "blocked",
    stage: "blocked",
    blockedReason: String(reason || "unknown"),
    updatedAt: Number(nowMs),
  };
}

/** WHAT: Checks whether a recorded sleeper may wake. WHY: Keeps a different session from inheriting stale authorization. */
export function sleepingWakeDecision({ state, sessionId } = {}) {
  if (!state || state.status === "awake") return { ok: true, tracked: false, reason: "not-asleep" };
  if (!["asleep", "wake_pending"].includes(state.status)) {
    return { ok: false, tracked: true, reason: `sleep-state-${state.status}` };
  }
  if (!state.sessionId || state.sessionId !== sessionId) {
    return { ok: false, tracked: true, reason: "sleep-session-mismatch" };
  }
  return { ok: true, tracked: true, reason: "exact-sleep-session" };
}

/** WHAT: Checks sleep eligibility from complete evidence. WHY: Keeps unknown or active work from being stopped. */
export function planSleep({
  engine,
  idleMs,
  busy,
  paneStatus,
  transportState,
  liveDeliveryJobs,
  worktreeClean,
  rebaseInProgress,
  processRunning,
  attached,
  excluded,
} = {}) {
  if (engine !== "claude") return { allow: false, reason: "unsupported-engine" };
  if (excluded) return { allow: false, reason: "excluded-pane" };
  if (!Number.isFinite(Number(idleMs))) return { allow: false, reason: "activity-unknown" };
  if (Number(idleMs) < PANE_SLEEP_IDLE_MS) return { allow: false, reason: "idle-threshold-not-met" };
  if (busy !== false) return { allow: false, reason: "active-or-unknown-turn" };
  if (paneStatus !== "idle") return { allow: false, reason: "work-not-provably-done" };
  if (MODAL_TRANSPORT_STATES.has(transportState) || transportState !== "empty-idle") {
    return { allow: false, reason: "modal-input-or-unknown" };
  }
  if (Number(liveDeliveryJobs) !== 0) return { allow: false, reason: "live-or-unknown-delivery" };
  if (worktreeClean !== true) return { allow: false, reason: "dirty-or-unknown-worktree" };
  if (rebaseInProgress !== false) return { allow: false, reason: "rebase-or-unknown-operation" };
  if (processRunning !== true) return { allow: false, reason: "process-not-provably-running" };
  if (attached !== false) return { allow: false, reason: "pane-attached-or-unknown" };
  return { allow: true, reason: "ok" };
}

/** WHAT: Filters eligible panes from observations. WHY: Keeps policy evaluation centralized and deterministic. */
export function findSleepCandidates({ panes = [], nowMs } = {}) {
  if (!Number.isFinite(Number(nowMs))) return [];
  return panes.flatMap((pane) => {
    const activity = Number(pane?.lastActivityMs);
    const idleMs = Number.isFinite(activity) && activity > 0 ? Number(nowMs) - activity : NaN;
    const plan = planSleep({ ...pane, idleMs });
    return plan.allow ? [{ key: String(pane.key), idleMs }] : [];
  });
}

/** WHAT: Checks an exact compact-and-idle receipt. WHY: Keeps incomplete compaction from authorizing process exit. */
export function compactReceiptOk(receipt = {}) {
  return receipt.version === 1
    && receipt.engine === "claude"
    && Number.isSafeInteger(receipt.sleepGeneration)
    && receipt.sleepGeneration > 0
    && typeof receipt.sessionId === "string"
    && receipt.sessionId.length > 0
    && receipt.compactBoundary === true
    && typeof receipt.compactCursorHash === "string"
    && /^[0-9a-f]{16}$/u.test(receipt.compactCursorHash)
    && typeof receipt.nonce === "string"
    && receipt.nonce.length >= 8
    && receipt.response === `AMUX_SLEEP_CHECK_${receipt.nonce}_OK`
    && receipt.observations === 2
    && receipt.noActivityAfterCheck === true;
}

/** WHAT: Encodes a journal cursor fingerprint. WHY: Keeps receipts small while binding them to observed files. */
export function cursorHash(cursor) {
  return createHash("sha256")
    .update(JSON.stringify(cursor?.positions || {}))
    .digest("hex")
    .slice(0, 16);
}

/** WHAT: Checks for user work after a sleep fence. WHY: Keeps late input from being lost during shutdown. */
export function hasClaudeUserActivityAfterCursor(cursor) {
  const files = Object.keys(cursor?.positions || {});
  if (!files.length) return true;
  return jsonlEventsAfterCursor(files, cursor).some((event) =>
    (event?.type === "user" && typeof event.message?.content === "string")
      || (event?.type === "queue-operation" && event.operation === "enqueue")
      || (event?.type === "attachment" && event.attachment?.type === "queued_command"));
}

function formatIdle(idleMs) {
  const hours = Math.floor(Math.max(0, Number(idleMs)) / 3_600_000);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function dedupeByKey(items, maxItems) {
  const unique = new Map();
  for (const item of items) if (item?.key && !unique.has(item.key)) unique.set(item.key, item);
  return { kept: [...unique.values()].slice(0, maxItems), total: unique.size };
}

/** WHAT: Formats one bounded fleet sleep rollup. WHY: Keeps maintenance warnings useful without alert spam. */
export function planSleepRollup({ candidates = [], stuck = [], maxItems = 8 } = {}) {
  const sleepers = dedupeByKey(candidates, maxItems);
  const jammed = dedupeByKey(stuck, maxItems);
  const lines = [sleepers.total
    ? `Sleep candidates (${sleepers.kept.length}${sleepers.total > sleepers.kept.length ? ` of ${sleepers.total}` : ""}):`
    : "Sleep candidates: none."];
  for (const item of sleepers.kept) lines.push(`  ${item.key}: idle ${formatIdle(item.idleMs)}`);
  lines.push(jammed.total
    ? `Possibly stuck (${jammed.kept.length}${jammed.total > jammed.kept.length ? ` of ${jammed.total}` : ""}; report only):`
    : "Possibly stuck: none.");
  for (const item of jammed.kept) lines.push(`  ${item.key}: ${item.evidence || "evidence unavailable"}`);
  return lines.join("\n");
}

/** WHAT: Calculates a fleet rollup deduplication key. WHY: Keeps repeated sweeps from emitting duplicate alerts. */
export function rollupKey(candidates = [], stuck = []) {
  const parts = [
    ...candidates.map((item) => `c:${item.key}:${Math.floor(Number(item.idleMs || 0) / ROLLUP_KEY_BUCKET_MS)}`),
    ...stuck.map((item) => `s:${item.key}:${item.processGeneration || "unknown"}`),
  ].sort();
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}
