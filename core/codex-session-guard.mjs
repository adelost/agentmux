// Pane-scoped, fail-closed codex session selection.
//
// Root cause of the skydive model-override incident (hit p7 and p9 in one day):
// agent.mjs launched a respawned codex pane with `codex resume --last`, which
// resumes the globally most-recent rollout — not the pane's own. A respawn could
// therefore attach to a DIFFERENT live pane's session, producing two writers on
// one rollout with interleaved model/effort/context (a pane shows `max` when it
// should show `xhigh`, alternating).
//
// This guard is the ownership authority: a pane resumes ONLY its own persisted
// session id whose provenance matches the pane. The live-writer FD check is
// DEFENSE-IN-DEPTH, not the ownership source — a dead-but-foreign session is
// still refused on provenance, and a live-held own session is refused on the FD
// check. Anything missing / foreign / ambiguous / held resolves to a FRESH
// codex session; on-disk WIP is never touched. `resume --last` is never used.

import { readdirSync, readlinkSync } from "fs";
import { join } from "path";

/** WHAT: Live pids (other than self) whose fds point at a rollout file.
 *  WHY: A live writer means resuming that rollout would create a second one —
 *  defense-in-depth on top of the provenance check, never a substitute for it. */
export function liveRolloutWriters(rolloutPath, {
  procRoot = "/proc",
  selfPid = process.pid,
  listDir = readdirSync,
  readLink = readlinkSync,
} = {}) {
  const holders = [];
  let pids;
  try {
    pids = listDir(procRoot).filter((name) => /^\d+$/u.test(name));
  } catch {
    return holders;
  }
  for (const pid of pids) {
    if (Number(pid) === selfPid) continue;
    let fds;
    try {
      fds = listDir(join(procRoot, pid, "fd"));
    } catch {
      continue; // process exited or fd dir unreadable — not a live holder we can prove
    }
    for (const fd of fds) {
      let target;
      try {
        target = readLink(join(procRoot, pid, "fd", fd));
      } catch {
        continue;
      }
      if (target === rolloutPath) {
        holders.push(Number(pid));
        break;
      }
    }
  }
  return holders;
}

/**
 * WHAT: Decides how a codex pane starts — resume its exact own session, or fresh.
 * WHY: Pane-scoped, provenance-gated, fail-closed resume is the only safe answer;
 *      the global-latest (`--last`) shortcut is the hijack this replaces.
 *
 * @param pane            requesting pane identity, e.g. "skydive:7".
 * @param persisted       the pane's own persisted session record
 *                        `{ sessionId, pane }`, or null if none was recorded.
 * @param rolloutPathFor  (sessionId) => absolute rollout path | null.
 * @param writersFor      (rolloutPath) => number[] of live writer pids.
 * @returns frozen `{ action: "resume"|"fresh", pane, sessionId, reason, heldBy? }`.
 */
export function decideCodexStart({ pane, persisted, rolloutPathFor, writersFor }) {
  const fresh = (reason, extra = {}) =>
    Object.freeze({ action: "fresh", pane, sessionId: null, reason, ...extra });

  if (!persisted || !persisted.sessionId) return fresh("no-persisted-session");
  // Ownership authority: a session that belongs to another pane is refused even
  // when it is dead/unheld — that is exactly the `--last` global-latest hijack.
  if (persisted.pane !== pane) return fresh("foreign-provenance");

  const rolloutPath = rolloutPathFor(persisted.sessionId);
  if (!rolloutPath) return fresh("session-rollout-missing");

  const writers = writersFor(rolloutPath) || [];
  if (writers.length > 0) {
    // Defense-in-depth: our own recorded session is still being written by a
    // live process (e.g. an un-reaped prior incarnation) — never join it.
    return fresh("rollout-held-by-live-writer", { heldBy: Object.freeze([...writers]) });
  }

  return Object.freeze({
    action: "resume",
    pane,
    sessionId: persisted.sessionId,
    reason: "own-unheld-session",
  });
}

/** WHAT: An auditable provenance record for a model-override / session-choice.
 *  WHY: The incident left no record of who/what changed a pane's model or which
 *  session a respawn attached to; provenance makes the change reconstructable. */
export function modelOverrideAudit({
  pane, fromModel, toModel, actor, source, sessionAction, sessionId, at,
}) {
  for (const [key, value] of [["pane", pane], ["actor", actor], ["source", source]]) {
    if (!value) throw new Error(`modelOverrideAudit requires ${key}`);
  }
  if (typeof at !== "number" || !Number.isFinite(at)) {
    throw new Error("modelOverrideAudit requires a finite numeric timestamp");
  }
  return Object.freeze({
    kind: "model-override",
    pane,
    fromModel: fromModel ?? null,
    toModel: toModel ?? null,
    actor,
    source,
    sessionAction: sessionAction ?? null,
    sessionId: sessionId ?? null,
    at,
  });
}
