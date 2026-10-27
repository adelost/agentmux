import { readDreamOwnerResult } from "./dream-owner.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** WHAT: Stores how often the controller looks for the curator's file. WHY: Keeps a wait of hours from flooding the pane or the log. */
export const DREAM_POLL_MS = 60_000;

/** WHAT: Reads the curator's result file once a minute until the deadline. WHY: Keeps the file the only receipt, so a slow night or busy pane never loses a digest. */
export async function waitForDreamOwnerResult({
  ctx, owner, outputPath, dateKey, runId, sourceSha256, deadlineMs,
  pollMs = DREAM_POLL_MS, sleep = wait, nowMs = Date.now, getStatus = null,
}) {
  for (;;) {
    const result = readDreamOwnerResult(outputPath, dateKey, runId, owner, sourceSha256);
    if (result.ok) return result;
    if (nowMs() >= deadlineMs) {
      const limited = getStatus && await getStatus(owner).catch(() => "unknown") === "limited"
        && !await ctx.agent.isBusy(owner.agent, owner.pane).catch(() => true);
      return { ok: false, reason: limited ? "dream-owner-limited" : result.reason };
    }
    await sleep(pollMs);
  }
}
