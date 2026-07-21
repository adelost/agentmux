// Durable activity boundary for the stateless nightly fleet summarizer.

import {
  chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { dirname, join } from "path";
import { isWorkDirective } from "./system-noise.mjs";

export const DREAM_RECEIPTS_SCHEMA_VERSION = 1;

/** WHAT: Resolves the user-local receipt store. WHY: Keeps cursors outside transient worktrees. */
export function defaultDreamReceiptPath(home = homedir()) {
  return join(home, ".agentmux", "dream-receipts.json");
}

export function emptyDreamReceipts() {
  return { schemaVersion: DREAM_RECEIPTS_SCHEMA_VERSION, panes: {} };
}

/** WHAT: Checks one cursor timestamp. WHY: Prevents invalid boundaries from authorizing receipt writes. */
export function validDreamCursor(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** WHAT: Reads validated per-pane cursors. WHY: Keeps corrupt state from silently skipping or reusing work. */
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
    if (!/^[a-zA-Z0-9_-]+:\d+$/.test(key) || !validDreamCursor(receipt?.activityCursor)
        || !validDreamCursor(receipt?.dreamedAt)) {
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

/** WHAT: Stores one successful batch atomically. WHY: Prevents partial receipts from losing unsummarized panes. */
export function recordDreamReceipts(state, targets, {
  path = defaultDreamReceiptPath(), dateKey, now = new Date(),
} = {}) {
  const panes = { ...state.panes };
  for (const target of targets) {
    if (!validDreamCursor(target?.activityCursor)) {
      throw new Error(`cannot receipt ${target?.agent}:${target?.pane} without an activity cursor`);
    }
    panes[`${target.agent}:${target.pane}`] = {
      activityCursor: target.activityCursor,
      dreamedAt: now.toISOString(),
      dateKey,
      summarizedTurns: target.turns,
    };
  }
  const next = { schemaVersion: DREAM_RECEIPTS_SCHEMA_VERSION, panes };
  writeDreamReceipts(next, path);
  return next;
}

/** WHAT: Stores one target through the batch API. WHY: Keeps existing callers from bypassing atomic validation. */
export function recordDreamReceipt(state, target, options = {}) {
  return recordDreamReceipts(state, [target], options);
}

/** WHAT: Checks whether a user-role turn represents real work. WHY: Prevents maintenance from feeding Dream itself. */
export function isDreamActivityTurn(text) {
  return isWorkDirective(text);
}
