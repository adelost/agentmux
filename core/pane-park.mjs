// WHAT: Durable park-state for model-downgraded panes, mirrored to events.
// WHY: The api:3 incident (2026-07-10): model-watch parked a quota-downgraded
//      pane (escape + stop-brief, pane acked), but inter-agent briefs woke it
//      and it worked 45+ min on the fallback model — commits included. Park
//      state must be visible to EVERY send path, and bridge and CLI are
//      separate processes, so it lives in a dedicated append-only ledger.
//
// Semantics: latest park/unpark event wins. Parks expire after
// PARK_MAX_AGE_MS — a stale flag that outlives its incident (bridge died
// before the upgrade was observed) must not dead-letter briefs forever.
// Fail-open by time, fail-loud at send time.

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { appendEvent, readEvents } from "./events.mjs";
import { isSlashCommand } from "./delivery.mjs";

export const PARK_EVENT = "pane_parked";
export const UNPARK_EVENT = "pane_unparked";
// Quota windows reset within hours; 12h comfortably covers an evening
// incident without letting a forgotten flag block tomorrow's work.
export const PARK_MAX_AGE_MS = 12 * 3600 * 1000;

export function parkStatePath() {
  return process.env.AMUX_PARK_STATE_PATH || join(homedir(), ".agentmux", "pane-parks.jsonl");
}

export function parkPane({ session, pane, detail = "", path } = {}) {
  appendRow(PARK_EVENT, session, pane, detail, path);
}

export function unparkPane({ session, pane, detail = "", path } = {}) {
  appendRow(UNPARK_EVENT, session, pane, detail, path);
}

function appendRow(event, session, pane, detail, path) {
  const row = {
    ts: new Date().toISOString(),
    event,
    session,
    pane: Number(pane) || 0,
    detail: String(detail || ""),
  };
  if (path) {
    appendEvent(row, path);
    return;
  }

  // The general event ledger is a bounded activity feed. Its readers only
  // scan a tail and rotation may discard older rows, so it cannot own a
  // 12-hour safety interlock. Keep a tiny dedicated append-only ledger for
  // the state contract and mirror the event to the main ledger for UX.
  appendEvent(row, parkStatePath());
  try {
    appendEvent(row);
  } catch (err) {
    // The state write already succeeded. Visibility degradation must not make
    // callers believe the safety interlock failed.
    console.error(`[pane-park] event mirror failed: ${err.message}`);
  }
}

/**
 * Current park state for a pane: null when not parked, else
 * { sinceMs, detail }. Reads the ledger tail; corrupt rows are skipped
 * by readEvents. Events older than PARK_MAX_AGE_MS are ignored entirely,
 * which is what expires a stale park.
 */
export function readParkState(session, pane, { path, now = Date.now() } = {}) {
  const opts = { since: new Date(now - PARK_MAX_AGE_MS).toISOString() };
  if (path) {
    opts.path = path;
  } else {
    const dedicated = parkStatePath();
    // Migration path for a bridge upgraded while a pane is already parked:
    // old versions wrote only to events.jsonl. Once the dedicated ledger has
    // its first row it is authoritative and immune to activity-feed churn.
    if (existsSync(dedicated)) opts.path = dedicated;
  }
  // Park state is safety-critical. Never inherit readEvents' 256KB activity
  // tail, which can cover less than PARK_MAX_AGE_MS on a busy fleet.
  opts.tailBytes = 0;
  let park = null;
  for (const evt of readEvents(opts)) {
    if (evt.session !== session || (Number(evt.pane) || 0) !== (Number(pane) || 0)) continue;
    if (evt.event === PARK_EVENT) {
      const ms = new Date(evt.ts || 0).getTime();
      park = { sinceMs: Number.isFinite(ms) ? ms : now, detail: evt.detail || "" };
    } else if (evt.event === UNPARK_EVENT) {
      park = null;
    }
  }
  return park;
}

/**
 * The guard's decision, pure so it is testable without a ledger.
 *
 * Prompts (work) are blocked at a parked pane: a brief wakes it and the
 * work runs on the fallback model. Slash commands are administration
 * (/model IS the recovery action, /compact and friends do not brief new
 * work) and pass. `force` is the human/explicit override.
 */
export function shouldBlockSend({ text, park, force = false } = {}) {
  if (!park || force) return false;
  return !isSlashCommand(text);
}

/**
 * Two-strike confirm for a parked pane's Discord briefs. A park exists to stop
 * silent work on a downgraded model, but the human is not always the one who
 * downgraded it and may deliberately want the new model (Mattias: fable→opus is
 * fine now). So the FIRST brief after a park warns without delivering; a SECOND
 * brief is an explicit human confirmation ("send again") — deliver it and clear
 * the park so the pane and every later brief flow normally. A newer park
 * (different timestamp) re-warns. `warnedSinceMs` is the park we already warned
 * about; null on the first brief this incident.
 */
export function decideParkedSend({ park, warnedSinceMs = null } = {}) {
  if (!park) return { action: "deliver" };
  if (warnedSinceMs === park.sinceMs) return { action: "confirm" };
  return { action: "warn", sinceMs: park.sinceMs };
}

/** One-line explanation for the sender when a brief is blocked. */
export function blockedSendMessage(paneKey, park, { now = Date.now() } = {}) {
  const mins = Math.max(0, Math.round((now - park.sinceMs) / 60000));
  return `🅿 ${paneKey} är parkerad efter modell-nedgradering (${park.detail || "okänd"}, ${mins} min sedan). ` +
    `Briefen levererades INTE — arbete nu skulle köras på fallback-modellen. ` +
    `Byt tillbaka modellen först (/model), eller skicka om med --force om det är avsiktligt.`;
}
