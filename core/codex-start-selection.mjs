import { join } from "node:path";
import { latestCodexSessionIdentity } from "./codex-jsonl-reader.mjs";
import { allowsFreshCodexBootstrap, decideCodexStart, liveRolloutWriters } from "./codex-session-guard.mjs";

/** WHAT: Returns an exact resume or an explicitly requested fresh session. WHY: Keeps ordinary wakes from erasing context or reviving a forbidden model. */
export function selectCodexStart({ dir, profile, owner, remembered, launch, configuredSessionId,
  discover = latestCodexSessionIdentity, writers = liveRolloutWriters }) {
  const discovered = discover(dir, { sessionDirs: [join(profile.home, "sessions")] });
  const requestedSessionId = launch?.resumeSessionId || configuredSessionId || null;
  if (launch?.newSession === true) {
    if (discovered && writers(discovered.path).length) throw new Error("fresh Codex session blocked: the old rollout still has a live writer");
    return { decision: { action: "fresh", pane: owner, sessionId: null, reason: "explicit-new-session" },
      discovered, requestedSessionId: null };
  }
  const persisted = requestedSessionId ? { pane: owner, sessionId: requestedSessionId }
    : discovered ? { pane: owner, sessionId: discovered.sessionId }
      : remembered?.sessionId ? { pane: owner, sessionId: remembered.sessionId } : null;
  const decision = decideCodexStart({ pane: owner, persisted,
    rolloutPathFor: sessionId => discovered?.sessionId === sessionId ? discovered.path : null,
    writersFor: writers, allowFreshBootstrap: !discovered && !requestedSessionId && allowsFreshCodexBootstrap(owner, remembered) });
  if (decision.action === "blocked") {
    const holders = decision.heldBy?.length ? ` (live writer ${decision.heldBy.join(",")})` : "";
    throw new Error(`Codex continuity blocked for ${owner}: ${decision.reason}${holders}`);
  }
  return { decision, discovered, requestedSessionId };
}
