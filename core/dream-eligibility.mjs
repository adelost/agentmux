// Durable activity boundary and action policy for nightly pane dreams.

import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";
import { getContextPercent } from "./context.mjs";
import { latestJsonlMtime, panePathFor, readLastTurns } from "./jsonl-reader.mjs";
import { isSystemNoiseDirective } from "./system-noise.mjs";

/** WHAT: Defines the dream cursor schema version. WHY: Keeps incompatible state from silently authorizing wakes. */
export const DREAM_RECEIPTS_SCHEMA_VERSION = 1;
/** WHAT: Defines the production activity floor. WHY: Keeps incidental pane touches from invoking a model. */
export const DEFAULT_DREAM_MIN_TURNS = 10;
/** WHAT: Defines the compact decision boundary. WHY: Keeps memory eligibility independent from context pressure. */
export const DEFAULT_DREAM_COMPACT_PERCENT = 50;

/** WHAT: Resolves the user-local receipt store. WHY: Keeps durable cursors outside transient worktrees. */
export function defaultDreamReceiptPath(home = homedir()) {
  return join(home, ".agentmux", "dream-receipts.json");
}

/** WHAT: Builds canonical empty state. WHY: Keeps first-run behavior on the same versioned contract as later runs. */
export function emptyDreamReceipts() {
  return { schemaVersion: DREAM_RECEIPTS_SCHEMA_VERSION, panes: {} };
}

function validCursor(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** WHAT: Reads validated per-pane cursors. WHY: Keeps corrupt or future state from reauthorizing old activity. */
export function readDreamReceipts(path = defaultDreamReceiptPath()) {
  if (!existsSync(path)) return emptyDreamReceipts();
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`dream receipt state is unreadable: ${error.message}`); }
  if (parsed?.schemaVersion !== DREAM_RECEIPTS_SCHEMA_VERSION
      || !parsed.panes || typeof parsed.panes !== "object" || Array.isArray(parsed.panes)) {
    throw new Error("dream receipt state has an unsupported shape");
  }
  for (const [key, receipt] of Object.entries(parsed.panes)) {
    if (!/^[a-zA-Z0-9_-]+:\d+$/.test(key) || !validCursor(receipt?.activityCursor)
        || !validCursor(receipt?.dreamedAt)) {
      throw new Error(`dream receipt state has an invalid pane receipt: ${key}`);
    }
  }
  return parsed;
}

function writeDreamReceipts(state, path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch {}
}

/** WHAT: Stores one successful activity boundary atomically. WHY: Keeps the same turns from authorizing another dream. */
export function recordDreamReceipt(state, target, {
  path = defaultDreamReceiptPath(),
  dateKey,
  now = new Date(),
} = {}) {
  if (!validCursor(target?.activityCursor)) {
    throw new Error(`cannot receipt ${target?.agent}:${target?.pane} without an activity cursor`);
  }
  const key = `${target.agent}:${target.pane}`;
  const next = {
    schemaVersion: DREAM_RECEIPTS_SCHEMA_VERSION,
    panes: {
      ...state.panes,
      [key]: {
        activityCursor: target.activityCursor,
        dreamedAt: now.toISOString(),
        dateKey,
        summarizedTurns: target.turns,
      },
    },
  };
  writeDreamReceipts(next, path);
  return next;
}

/** WHAT: Checks whether a turn represents real work. WHY: Keeps dream and recovery plumbing from self-waking panes. */
export function isDreamActivityTurn(text) {
  const head = String(text || "").trimStart();
  return !isSystemNoiseDirective(head) && !/^\[dream\b/i.test(head);
}

/** WHAT: Collects real dream activity after a cursor. WHY: Keeps the generic catch-up counter contract unchanged. */
export function countDreamTurnsSince(paneDir, sinceTs) {
  const cutoffMs = sinceTs ? new Date(sinceTs).getTime() : null;
  const since = Number.isFinite(cutoffMs) ? new Date(cutoffMs) : null;
  const result = readLastTurns(paneDir, { since, limit: Number.MAX_SAFE_INTEGER });
  if (!result) return null;
  const turns = result.turns.filter((turn) => {
    const timestamp = Date.parse(turn.timestamp || "");
    return Number.isFinite(timestamp)
      && (cutoffMs === null || timestamp > cutoffMs)
      && isDreamActivityTurn(turn.userPrompt);
  });
  return {
    count: Math.min(turns.length, 51),
    latest: turns.at(-1)?.timestamp ?? null,
    capped: turns.length > 51,
  };
}

/** WHAT: Maps activity and context to dream actions. WHY: Keeps low context from suppressing meaningful memory writes. */
export function planDreamActions({
  turns,
  contextPercent,
  minTurns = DEFAULT_DREAM_MIN_TURNS,
  compactPercent = DEFAULT_DREAM_COMPACT_PERCENT,
}) {
  if (!Number.isFinite(turns) || turns < minTurns) {
    return { eligible: false, compact: false, memory: false, reason: "below-min-turns" };
  }
  const compact = Number.isFinite(contextPercent) && contextPercent >= compactPercent;
  return { eligible: true, compact, memory: true, reason: compact ? "compact-then-memory" : "memory-only" };
}

/** WHAT: Checks for an exactly idle pane. WHY: Keeps nightly writes from interrupting active or modal work. */
export function isDreamRunnableStatus(status) {
  return status === "idle";
}

/** WHAT: Checks for a live Claude process. WHY: Keeps Claude-specific prompts away from incompatible runtimes. */
export function isDreamLiveClaudePane(pane) {
  return pane?.command === "claude";
}

function isDreamClaudePane(cmd) {
  return String(cmd || "").trim().startsWith("claude");
}

function receiptCutoff(receipts, key, sinceMs) {
  const cursor = receipts.panes[key]?.activityCursor;
  return cursor && validCursor(cursor) ? new Date(cursor) : new Date(sinceMs);
}

/** WHAT: Collects pane targets without mutating them. WHY: Keeps eligibility measurement separate from delivery. */
export async function collectDreamTargets(ctx, agents, sinceMs, opts = {}) {
  const getStatus = opts.getStatus;
  const getMtime = opts.getMtime || latestJsonlMtime;
  const getLivePanes = opts.getLivePanes;
  const getTurns = opts.getTurns || countDreamTurnsSince;
  const getContext = opts.getContext || ((paneDir) => getContextPercent(paneDir, "claude"));
  const receipts = opts.receipts || emptyDreamReceipts();
  const minTurns = opts.minTurns ?? DEFAULT_DREAM_MIN_TURNS;
  const compactPercent = opts.compactPercent ?? DEFAULT_DREAM_COMPACT_PERCENT;
  if (typeof getStatus !== "function" || typeof getLivePanes !== "function") {
    throw new Error("dream target collection requires getStatus and getLivePanes");
  }

  const targets = [];
  const skipped = [];
  const ineligible = [];
  for (const agent of agents) {
    let livePanes = [];
    try { livePanes = await getLivePanes(ctx, agent.name); } catch {}
    const liveByIndex = new Map((livePanes || []).map((pane) => [pane.index, pane]));
    const panes = Array.isArray(agent.panes) ? agent.panes : [];
    for (let pane = 0; pane < panes.length; pane++) {
      if (!isDreamClaudePane(panes[pane]?.cmd)) continue;
      const paneDir = panePathFor(agent, pane);
      let lastMs = 0;
      try { lastMs = getMtime(paneDir) || 0; } catch {}
      if (lastMs < sinceMs) continue;

      const key = `${agent.name}:${pane}`;
      const paneReceipt = receipts.panes[key] || null;
      const cutoff = receiptCutoff(receipts, key, sinceMs);
      let activity = null;
      try { activity = getTurns(paneDir, cutoff); } catch {}
      const turns = activity?.count ?? 0;
      const activityCursor = activity?.latest ?? null;
      const base = {
        agent: agent.name,
        pane,
        lastMs,
        turns,
        activityCursor,
        receiptDateKey: paneReceipt?.dateKey ?? null,
      };
      if (turns < minTurns || !validCursor(activityCursor)) {
        ineligible.push({ ...base, status: "below-min-turns", minTurns });
        continue;
      }

      const livePane = liveByIndex.get(pane);
      const liveCommand = livePane?.command || "missing";
      if (!isDreamLiveClaudePane(livePane)) {
        skipped.push({ ...base, status: "not-live-claude", liveCommand });
        continue;
      }
      let status = "unknown";
      try { status = await getStatus(ctx, agent.name, pane); } catch {}
      if (!isDreamRunnableStatus(status)) {
        skipped.push({ ...base, status, liveCommand });
        continue;
      }

      let contextPercent = null;
      try { contextPercent = getContext(paneDir)?.percent ?? null; } catch {}
      const plan = planDreamActions({ turns, contextPercent, minTurns, compactPercent });
      targets.push({ ...base, status, liveCommand, contextPercent, compact: plan.compact });
    }
  }
  return { targets, skipped, ineligible };
}
