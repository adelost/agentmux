import { buildAskEntries } from "./ask-history.mjs";
import { isCompactUnsafe } from "./pane-status.mjs";

/** WHAT: Defines the recent-open recovery horizon. WHY: Keeps abandoned historical asks from waking as current work. */
export const DEFAULT_STOP_RECOVERY_WINDOW_MS = 6 * 60 * 60 * 1000;

const SLEEPING_PROCESS = /^(?:ba|z|fi)?sh$/u;

/** WHAT: Checks whether a tmux pane still hosts a coding process. WHY: Keeps stale status rows from reviving panes already asleep at stop time. */
export function hasResidentCodingProcess(command) {
  const value = String(command || "").trim();
  return Boolean(value && !SLEEPING_PROCESS.test(value));
}

/** WHAT: Returns one pane's deliberate-stop recovery evidence. WHY: Keeps completed resident processes outside the recovery set. */
export function stopRecoveryCandidate({
  agent,
  pane,
  paneStatus = "unknown",
  residentCommand = null,
  turns = [],
  nowMs = Date.now(),
  recentWindowMs = DEFAULT_STOP_RECOVERY_WINDOW_MS,
} = {}) {
  if (!hasResidentCodingProcess(residentCommand)) return null;
  const entries = buildAskEntries({ agent, pane, turns, paneStatus, nowMs });
  const latest = entries.at(-1) || null;
  const recentOpen = Boolean(latest?.open
    && Number.isFinite(latest.ageMs)
    && latest.ageMs >= 0
    && latest.ageMs <= recentWindowMs);
  const unsafeStatus = paneStatus !== "unknown" && isCompactUnsafe(paneStatus);
  if (!recentOpen && !unsafeStatus) return null;

  const interruptedAtMs = Number.isFinite(latest?.tsMs) ? latest.tsMs : nowMs;
  const evidence = unsafeStatus ? `pane-${paneStatus}` : `ask-${latest.status}`;
  return { agent, pane, interruptedAtMs, evidence };
}

/** WHAT: Builds one append-only recovery receipt. WHY: Prevents a partial per-pane batch from losing work. */
export function fleetStopRecoveryEvent(candidates, { stopId, now = new Date() } = {}) {
  if (!stopId || !Array.isArray(candidates) || candidates.length === 0) return null;
  return {
    ts: now.toISOString(),
    event: "fleet_stop_recovery",
    stopId,
    panes: candidates.map(({ agent, pane, interruptedAtMs, evidence }) => ({
      agent,
      pane,
      interruptedAtMs,
      evidence,
    })),
  };
}
