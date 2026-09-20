import { hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { codexLaunchDecision } from "../policies/context-cost.mjs";

/** WHAT: Checks a compact receipt for the exact resumed session. WHY: Prevents another pane's compact from authorizing a model change. */
export function validCodexCompactReceipt(receipt, sessionId) {
  if (!receipt?.ok || receipt.sessionId !== sessionId || !receipt.compactBoundary) return false;
  const files = Object.keys(receipt.cursor?.positions || {});
  if (files.length !== 1) return false;
  let compacted = false;
  hasJsonlEventAfterCursor(files, receipt.cursor, (event) => {
    if (event?.type === "compacted" || (event?.type === "event_msg" && event.payload?.type === "context_compacted")) compacted = true;
    else if (event?.type === "event_msg" && event.payload?.type === "user_message") compacted = false;
    return false;
  });
  return compacted;
}

/** WHAT: Routes one exact Codex session through compact-first launch. WHY: Keeps config changes, wake and recovery behind the same cost boundary as /model. */
export async function launchCodexWithPolicy({
  sessionId, previous, selected, blocked, retry = false, receipt = null,
  launch, compact, reset, verify, remember, recordBlocked,
  validReceipt = validCodexCompactReceipt,
}) {
  const decision = codexLaunchDecision({ sessionId, previous, selected,
    blocked: blocked?.target === selected.model && !retry, receipt: validReceipt(receipt, sessionId) });
  if (decision.values.action === "HOLD") throw new Error(`Codex model change blocked: ${decision.cell}: ${blocked?.reason || "previous model unknown"}`);
  try {
    if (decision.values.action === "COMPACT") {
      await launch(previous);
      const proof = await compact();
      if (!validReceipt(proof, sessionId)) throw new Error(`compact not verified: ${proof?.reason || "missing exact-session receipt"}`);
      await reset();
    }
    await launch(selected);
    const actual = await verify();
    if (actual?.model !== selected.model || (selected.effort && actual?.effort !== selected.effort)) {
      throw new Error(`requested ${selected.model}, running ${actual?.model || "unknown"}`);
    }
    remember(actual);
    return actual;
  } catch (error) {
    // This process was opened only for the guarded transition. Preserve its
    // journal and leave a shell, so a later prompt cannot slip past the gate.
    recordBlocked({ target: selected.model, reason: error.message });
    await reset();
    throw error;
  }
}
