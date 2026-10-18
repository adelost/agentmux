import { join } from "node:path";
import { latestCodexSessionIdentity } from "./codex-jsonl-reader.mjs";
import { allowsFreshCodexBootstrap, decideCodexStart, liveRolloutWriters } from "./codex-session-guard.mjs";

// Codex thread ids are UUIDv7, creation time first, so of two ids the greater one started later.
/** WHAT: Returns a filter for sessions started after a replaced one. WHY: Keeps a replaced session from being resumed however recently its rollout was touched. */
export const startedAfterSession = (replacedSessionId) => (meta) =>
  String(meta?.id || "").toLowerCase() > String(replacedSessionId).toLowerCase();

/** WHAT: Returns an exact resume or an explicitly requested fresh session. WHY: Keeps ordinary wakes from erasing context or reviving a forbidden model. */
export function selectCodexStart({ dir, profile, owner, remembered, launch, configuredSessionId,
  discover = latestCodexSessionIdentity, writers = liveRolloutWriters }) {
  const requestedSessionId = launch?.resumeSessionId || (!remembered?.deferredHandover ? configuredSessionId : null) || null;
  // A replaced session is never resumed again, even before its replacement has
  // written a rollout; only an explicitly requested session may reopen it.
  const replacedSessionId = requestedSessionId ? null : remembered?.supersededSessionId || null;
  const discovered = discover(dir, { sessionDirs: [join(profile.home, "sessions")],
    accept: replacedSessionId ? meta => startedAfterSession(replacedSessionId)(meta)
      && (!remembered?.deferredHandover?.createdAt || Date.parse(meta.timestamp) >= remembered.deferredHandover.createdAt) : null });
  if (launch?.newSession === true) {
    if (discovered && writers(discovered.path).length) throw new Error("fresh Codex session blocked: the old rollout still has a live writer");
    return { decision: { action: "fresh", pane: owner, sessionId: null, reason: "explicit-new-session" },
      discovered, requestedSessionId: null };
  }
  // With nothing newer than the replaced session on disk, its replacement never
  // wrote a rollout, so the pane starts fresh again.
  const persisted = requestedSessionId ? { pane: owner, sessionId: requestedSessionId }
    : discovered ? { pane: owner, sessionId: discovered.sessionId }
      : remembered?.sessionId && !replacedSessionId ? { pane: owner, sessionId: remembered.sessionId } : null;
  const decision = decideCodexStart({ pane: owner, persisted,
    rolloutPathFor: sessionId => discovered?.sessionId === sessionId ? discovered.path : null,
    writersFor: writers, allowFreshBootstrap: !discovered && !requestedSessionId
      && (Boolean(replacedSessionId) || allowsFreshCodexBootstrap(owner, remembered)) });
  if (decision.action === "blocked") {
    const holders = decision.heldBy?.length ? ` (live writer ${decision.heldBy.join(",")})` : "";
    throw new Error(`Codex continuity blocked for ${owner}: ${decision.reason}${holders}`);
  }
  return { decision, discovered, requestedSessionId };
}
