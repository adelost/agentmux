// An account's stop moves its panes to an account with room instead of parking them (lsrc:0 for Mattias,
// 2026-10-21, day file 04:14Z). His rule at 03:49Z (skill amux-accounts, facd3ec9): when the floor holds panes because
// their account's week is spent and another logged-in account has room, they move there at once without asking.
// The rotation /byt and `amux accounts rotate` use moves each idle pane in its exact session, leaves a busy one for a
// later tick, and takes the prompts the floor held along.
// lsrc:0 07:0xZ (case 11): at 07:00Z Claude A's session read 75 % with 21 panes and reset at 08:50Z, so it would stop the
// fleet until then while Claude W's week had renewed. A session near its limit moves its panes too when its reset lies
// beyond the cache's life; a sooner reset keeps them waiting on their warm cache.

import { accountWindows, nearLimit, QUOTA_PARK_POLICY, quotaFloorHold } from "../core/quota-park.mjs";
import { readQuotaSnapshotWithPanes } from "../core/quota-in-use.mjs";
import { moveTarget, quotaObservedAt } from "../core/quota-wind-down.mjs";
import { bridgeRotationRuntime } from "./account-switch-command.mjs";
import { recordPauseCompactLine } from "./pause-compact.mjs";
import { parseQuotaWarningConfig } from "./quota-warning.mjs";

// A reading older than this is not verified room, nor proof that the source still stands at its floor.
const FRESH_MS = 10 * 60_000;

/** WHAT: Returns the window that stops an account's panes for longer than their cache lives, or null. WHY: Keeps a short stop on its warm cache. */
export function stoppingWindow({ windows, floorPercent, now, policy = QUOTA_PARK_POLICY }) {
  if (quotaFloorHold({ windows, floorPercent, now })) return "week";
  const session = windows.find((window) => window.kind === "session" && Number.isFinite(window.usedPercent));
  const resetIn = Date.parse(session?.resetsAt) - now;
  return resetIn > policy.outlastMs.claude && nearLimit(session, now, policy) ? "session" : null;
}

/** WHAT: Returns each Claude account about to stop its panes and the account with most room. WHY: Keeps the bridge's mover and the night's replay on one rule. */
export function quotaStopMoves({ accounts = [], floorPercent, reservePercent = 90, now }) {
  return (accounts || []).flatMap((account) => {
    if (account?.provider !== "claude" || !account.ok || !account.inUse?.length || !(now - quotaObservedAt(account) <= FRESH_MS)) return [];
    const window = stoppingWindow({ windows: accountWindows(account), floorPercent, now });
    if (!window) return [];
    const target = moveTarget({ engine: "claude", accounts, from: { key: account.profile?.key, email: account.account?.email },
      readAfter: now - FRESH_MS, reservePercent });
    return target ? [{ from: account.name || account.profile?.key, window, panes: [...account.inUse], target }] : [];
  });
}

/** WHAT: Reads the stop mover's switch. WHY: Keeps his rule on by default with a way to watch it dry or turn it off. */
export function readQuotaStopMoveMode(env = process.env) {
  const mode = env.AMUX_QUOTA_STOP_MOVE || "on";
  if (!["off", "dry", "on"].includes(mode)) throw new Error("AMUX_QUOTA_STOP_MOVE must be off, dry or on");
  return mode;
}

/** WHAT: Builds the bridge's mover for panes an account's stop holds. WHY: Keeps the move on the one rotation every switch uses. */
export function createQuotaStopMover({ runtime, readSnapshot, rotate, floorPercent, reservePercent = 90, mode = "on",
  now = Date.now, record = () => {}, log = () => {} }) {
  let running = null;
  async function run() {
    const ctx = mode === "off" ? null : runtime();
    if (!ctx) return [];
    const moves = quotaStopMoves({ accounts: (await readSnapshot())?.accounts, floorPercent, reservePercent, now: now() });
    const results = [];
    for (const move of moves) {
      const line = { at: new Date(now()).toISOString(), pane: move.panes.join(","), cell: "quota-stop-move", from: move.from, to: move.target.name,
        window: move.window };
      if (mode === "dry") { record({ ...line, outcome: "would-move" }); results.push({ ...move, status: "dry" }); continue; }
      const result = await rotate(ctx, move.target.profileId, { only: move.panes }, { output: () => {}, setExitCode: () => {} });
      const rows = (result?.rows || []).map((row) => `${row.key}=${row.status}${row.reason ? `:${row.reason}` : ""}`);
      record({ ...line, outcome: result?.status || "unknown", detail: rows.join(" ") });
      log(`${move.from} ${move.window === "week" ? "at its floor" : "session near its limit"}: ${move.panes.length} panes to ${move.target.name}, ${result?.status}`);
      results.push({ ...move, status: result?.status, rows: result?.rows || [] });
    }
    return results;
  }
  const tick = () => (running ||= run().finally(() => { running = null; }));
  return {
    tick,
    start(intervalMs = 60_000) {
      const timer = setInterval(() => tick().catch((error) => log(`tick failed: ${error.message}`)), intervalMs);
      timer.unref?.();
      return timer;
    },
  };
}

/** WHAT: Builds and schedules the bridge's stop mover on the /byt rotation context. WHY: Keeps its wiring out of the bridge entry. */
export function startQuotaStopMover({ agent, deliveryBroker, state, configPath, floorPercent }) {
  const mover = createQuotaStopMover({
    runtime: bridgeRotationRuntime({ agent, deliveryBroker, state, configPath }),
    readSnapshot: () => readQuotaSnapshotWithPanes(),
    rotate: async (...args) => (await import("../cli/account-rotation.mjs")).rotateClaudeFleet(...args),
    floorPercent, reservePercent: parseQuotaWarningConfig().reservePercent, mode: readQuotaStopMoveMode(),
    record: recordPauseCompactLine, log: message => console.log(`quota-stop | ${message}`),
  });
  mover.start();
  return mover;
}
