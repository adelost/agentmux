// Exact Claude compact receipt shared by sleep and account rotation.

import { hasClaudeCompactBoundaryAfterSubmit } from "./claude-submit-boundary.mjs";
import { sendSlashVerified } from "./delivery.mjs";

const waitFor = async (attempts, delayMs, sleep, predicate) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return false;
};

/** WHAT: Routes one Claude compact through command and journal receipts. WHY: Prevents account rotation from killing unproven context. */
export async function verifiedClaudeCompact({
  agent,
  agentName,
  pane,
  paneDir,
  latestIdentity,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sendSlash = sendSlashVerified,
  hasBoundary = hasClaudeCompactBoundaryAfterSubmit,
  pollAttempts = 120,
  pollMs = 1_000,
  settleMs = 200,
} = {}) {
  const before = latestIdentity(paneDir);
  if (!before?.sessionId) return { ok: false, reason: "pre-compact-session-missing" };
  const cursor = await agent.capturePromptEchoCursor(
    agentName,
    pane,
    `AMUX-COMPACT-FENCE-${now()}`,
  ).catch(() => null);
  if (!cursor || !Object.keys(cursor.positions || {}).length) {
    return { ok: false, reason: "compact-cursor-missing" };
  }
  const submittedAt = now();
  const command = await sendSlash(agent, agentName, pane, "/compact", {
    suppressReceipt: true,
    settleMs,
    maxRescues: 2,
    sleep,
  });
  if (!command.delivered || command.via !== "command-receipt") {
    return { ok: false, reason: "compact-command-unverified" };
  }
  const boundary = await waitFor(
    pollAttempts,
    pollMs,
    sleep,
    () => hasBoundary(cursor, submittedAt),
  );
  if (!boundary) return { ok: false, reason: "compact-boundary-missing" };
  const after = latestIdentity(paneDir);
  if (!after?.sessionId) return { ok: false, reason: "post-compact-session-missing" };
  if (after.sessionId !== before.sessionId) {
    return { ok: false, reason: "compact-session-changed" };
  }
  return {
    ok: true,
    cursor,
    submittedAt,
    sessionId: after.sessionId,
    commandReceipt: command.via,
    compactBoundary: true,
  };
}
