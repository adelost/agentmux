import { readDreamOwnerResult } from "./dream-owner.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function terminalReceipt(response, owner, expected) {
  const source = owner.engine === "codex" ? "codex-jsonl" : "jsonl";
  const last = response?.items?.at(-1);
  return response?.source === source && last?.type === "text"
    && String(last.content || "").trim() === expected;
}

/** WHAT: Checks the exact final reply, valid product and idle state. WHY: Prevents commentary from blocking completion or a quoted/screen-only receipt from authorizing it. */
export async function waitForDreamOwnerResult({
  ctx, owner, prompt, outputPath, dateKey, runId, sourceSha256,
  attempts = 450, pollMs = 2_000, sleep = wait,
}) {
  const expected = `DREAM_OK ${dateKey} ${runId}`;
  let last = { ok: false, reason: "dream-output-missing" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = readDreamOwnerResult(outputPath, dateKey, runId, owner, sourceSha256);
    if (last.ok) {
      const busy = await ctx.agent.isBusy(owner.agent, owner.pane).catch(() => true);
      const response = await ctx.agent.getResponseStreamWithRaw(owner.agent, owner.pane, prompt).catch(() => null);
      if (!busy && terminalReceipt(response, owner, expected)) return last;
    }
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  return { ok: false, reason: last.reason || "dream-owner-response-missing" };
}
