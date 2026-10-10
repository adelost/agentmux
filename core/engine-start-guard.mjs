// Refuses to start a second process on an engine session that is already live.
//
// Incident 2026-10-10 (skyvw): after live panes were renumbered, `skyvw:.2`
// was an empty shell while the real agent-2 Claude ran in pane 10 from the
// same .agents/2 directory. A Discord /compact woke `.2`, and the start path
// resumed the newest session in .agents/2, which that live process still
// owned. Two processes then wrote one session.
//
// A start in pane N is refused, before anything is typed into the pane, when
// - another pane of the window runs an engine from pane N's directory, or
// - a live engine process was launched with the session id about to be
//   resumed (the same /proc argv scan Janitor trusts, liveNativeSessionIds).
// A restart may race its own just-killed process, so a held id is re-read
// for a short settle window before the refusal.

import { existsSync } from "fs";
import { resolve } from "path";
import { liveNativeSessionIds } from "./session-trim.mjs";
import { isEngineProcess } from "./tui-stall-recovery.mjs";

/** DTO: Message prefix of every refusal from this guard, matched by notice copy. */
export const ENGINE_START_REFUSED = "engine start refused";

const SETTLE_CHECKS = 40;
const SETTLE_STEP_MS = 250;

function refusal(target, detail) {
  const error = new Error(`${ENGINE_START_REFUSED}: ${detail}; nothing was started in ${target}`);
  error.code = "AMUX_ENGINE_START_REFUSED";
  return error;
}

/** WHAT: Returns another pane running an engine from this pane's directory. WHY: Keeps a renumbered agent from being started twice. */
export function twinEnginePane(rows, pane, dir) {
  const own = resolve(dir);
  return rows.find((row) => row.index !== Number(pane) && !row.dead
    && isEngineProcess(row.command) && row.path && resolve(row.path) === own) || null;
}

/**
 * WHAT: Builds the pre-launch check every engine start awaits.
 * WHY: Keeps two processes from writing one engine session.
 */
export function createEngineStartGuard({
  tmux, wait, procRoot = "/proc", liveSessionIds = liveNativeSessionIds, log = console.error,
}) {
  let warnedNoProc = false;

  async function heldSessionId(target, sessionId) {
    const id = String(sessionId).toLowerCase();
    for (let check = 0; check < SETTLE_CHECKS; check++) {
      const ids = liveSessionIds({ procRoot });
      if (ids === null) {
        if (existsSync(procRoot)) throw refusal(target, `cannot read live processes under ${procRoot} to prove session ${sessionId} is free`);
        if (!warnedNoProc) console.warn(`engine start guard: no ${procRoot} on this host; only the pane-directory check applies`);
        warnedNoProc = true;
        return false;
      }
      if (!ids.has(id)) return false;
      await wait(SETTLE_STEP_MS);
    }
    return true;
  }

  return async function assertEngineStartAllowed({ session, pane, dir, sessionId = null, engine = "engine" }) {
    const target = `${session}:${pane}`;
    try {
      let rows;
      try {
        rows = await tmux.paneRows(session);
      } catch (error) {
        throw refusal(target, `cannot list the panes of '${session}' to prove ${dir} is not running elsewhere (${error.message})`);
      }
      const twin = twinEnginePane(rows, pane, dir);
      if (twin) {
        throw refusal(target, `${session}:${twin.index} (${twin.id}, ${twin.command}) already runs from ${dir}`);
      }
      if (sessionId && await heldSessionId(target, sessionId)) {
        throw refusal(target, `${engine} session ${sessionId} is still held by another live process`);
      }
    } catch (error) {
      log(error.message);
      throw error;
    }
  };
}
