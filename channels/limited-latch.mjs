// Quota-stall memory for the poll loop: which panes are limited, and when a
// pane counts as entering that state. Pure apart from the ledger read.

import { readEvents } from "../core/events.mjs";

/** WHAT: Checks whether one observation enters the limited state. WHY: Keeps one quota alert per stall from repeating every poll. */
export function enteredLimited(prev, status) {
  return status === "limited" && prev !== "limited";
}

// `limited` is scraped from a banner in the pane tail (cli/format.mjs:65),
// and that banner scrolls out whenever anything else prints — a delivery,
// a keystroke, a redraw. The absence of the banner is therefore NOT
// evidence that the quota lifted. Overwriting the memory with that absence
// manufactures a fresh "entered limited" edge the next time the banner
// re-prints, which is why one quota-dead pane re-announced itself roughly
// hourly all day: every delivery into it produced one flap.
// So `limited` is a latch. Only a pane demonstrably RUNNING clears it;
// idle and unknown are absence of evidence, not evidence of recovery.
//
// "Running" cannot be a bare scraped `working` either, and that was the
// hole this latch still had. detectPaneStatus DELIBERATELY lets a live
// spinner footer beat banner residue, because after a reset the pane really
// has resumed while the old banner is still on screen (test/format-status
// pins that, and it is right for the compaction decision). But a delivery
// into a still-dead pane paints the same footer over a banner that has NOT
// expired, so the alert path read the flap as recovery and re-announced the
// stall on the next poll. Measured 2026-08-04 on skydive:3, a codex pane
// quota-dead until 9 Aug: 427 deliveries, 8 identical alerts to the human,
// five of them 60-66s after a delivery burst — one poll interval exactly.
//
// So the two consumers get the standard each needs. Compaction keeps the
// scraped status. The latch additionally requires the banner to be GONE:
// a visible quota banner is positive evidence the stall persists, and it
// outranks a footer that merely proves something was painted.
/** WHAT: Checks whether a status clears the limited latch. WHY: Keeps a footer painted over a live quota banner from counting as recovery. */
export const clearsLimitedLatch = (status, { limitBannerVisible = false } = {}) =>
  status === "working" && !limitBannerVisible;

/** WHAT: Returns the status a pane remembers after one observation. WHY: Keeps a scrolled-out banner from ending a quota stall. */
export function nextLimitedMemory(prev, status, options = {}) {
  if (status === "limited") return "limited";
  if (prev === "limited" && !clearsLimitedLatch(status, options)) return "limited";
  return status;
}

/**
 * Events that prove a pane actually RAN a turn, and therefore that a recorded
 * quota stall is over. `delivery_queue` and `notification` say only that
 * something was addressed TO the pane — a quota-dead pane collects those
 * exactly as a live one does, so they prove nothing about whether it can run.
 * They are also the ledger's loudest rows (7158 of 8000+ when this was written),
 * which is why keying on "the newest row of any kind" silently stopped working.
 */
const TURN_PROVING_EVENTS = new Set(["prompt", "stop", "session_start"]);

// The alert fires on a TRANSITION into limited, but the map holding the
// previous state is in memory. A restart therefore looked like every
// quota-dead pane had just this moment run out.
// A pane stays seeded as limited until a row that PROVES it ran again arrives
// after the stall. Same rule as the runtime latch above: only positive evidence
// of a turn clears a quota stall; traffic addressed to a silent pane is not it.
/** WHAT: Loads which panes were already limited from the durable ledger. WHY: Prevents a bridge restart from re-announcing every known quota stall. */
export function seedLimitedFromLedger(prevStatus, {
  readEventsFn = readEvents, since = null,
} = {}) {
  const limitedPerPane = new Map();
  try {
    for (const evt of readEventsFn({ since })) {
      if (!evt?.session) continue;
      const paneKey = `${evt.session}:${Number(evt.pane) || 0}`;
      if (evt.event === "limited") limitedPerPane.set(paneKey, true);
      else if (TURN_PROVING_EVENTS.has(evt.event)) limitedPerPane.set(paneKey, false);
    }
  } catch { return prevStatus; }
  for (const [paneKey, stillLimited] of limitedPerPane) {
    if (stillLimited) prevStatus.set(paneKey, "limited");
  }
  return prevStatus;
}
