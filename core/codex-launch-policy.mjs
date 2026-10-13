import { hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { readCodexRolloutModel } from "./codex-rollout-model.mjs";
import { codexPromptProgress } from "./codex-user-events.mjs";
import { codexLaunchDecision, codexResumeContext } from "../policies/context-cost.mjs";
import { latestConversationActivityMs } from "./pane-activity.mjs";

/** WHAT: Maps exact-session model and compact evidence to resume inputs. WHY: Prevents old remembered settings from hiding a later provider fallback. */
export function codexResumeEvidence({ sessionId, observed, rollout, remembered, launch, maintenance,
  allowFreshUnknown = false }) {
  const previous = sessionId && rollout?.sessionId === sessionId && rollout?.model ? rollout
    : sessionId && observed?.sessionId === sessionId && observed?.model ? observed
      : sessionId && remembered?.sessionId === sessionId && remembered?.model ? remembered : null;
  const resumeSessionId = sessionId && !previous && allowFreshUnknown ? null : sessionId;
  return {
    previous, resumeSessionId,
    launchOptions: { ...launch, compactReceipt: launch?.compactReceipt
      || (resumeSessionId && maintenance?.status === "VERIFIED" && maintenance.sessionId === resumeSessionId
        ? { ...maintenance, ok: true, compactBoundary: true } : null) },
  };
}

/** WHAT: Reads the exact rollout before a pane-owned start. WHY: Prevents a missing status tail from hiding a known model or bypassing compact. */
export async function prepareCodexResume({ decision, discovered, observed, remembered, launch,
  maintenance, requestedSessionId, dir = null, now = Date.now,
  activityFor = paneDir => latestConversationActivityMs(paneDir, "codex", { recoverCodexHistory: true }) }) {
  const rollout = decision.action === "resume"
    ? await readCodexRolloutModel(discovered.path, decision.sessionId) : null;
  const evidence = codexResumeEvidence({ sessionId: decision.sessionId, observed, rollout, remembered,
    launch, maintenance, allowFreshUnknown: decision.action === "resume" && !requestedSessionId });
  // Read before Codex opens the session: a resumed active goal starts a turn at once.
  if (evidence.resumeSessionId && dir) {
    const activity = activityFor(dir);
    evidence.launchOptions.resumeContext = codexResumeContext({
      tokens: observed?.sessionId === evidence.resumeSessionId ? observed.tokens : NaN,
      idleMs: Number.isFinite(activity) ? now() - activity : NaN,
      tried: Boolean(maintenance && maintenance.sessionId === evidence.resumeSessionId && maintenance.status !== "VERIFIED") });
  }
  const startRecord = evidence.resumeSessionId
    ? { ...remembered, sessionId: decision.sessionId, status: "ready", rolloutPath: discovered.path }
    : { sessionId: null, status: "awaiting-first-rollout", startedAt: Date.now(),
      supersededSessionId: decision.action === "resume" ? decision.sessionId : null,
      modelTransitionBlocked: remembered?.sessionId == null ? remembered?.modelTransitionBlocked ?? null : null };
  return { ...evidence, startRecord };
}

/** WHAT: Checks a compact receipt for the exact resumed session. WHY: Prevents another pane's compact from authorizing a model change. */
export function validCodexCompactReceipt(receipt, sessionId) {
  if (!receipt?.ok || receipt.sessionId !== sessionId || !receipt.compactBoundary) return false;
  const files = Object.keys(receipt.cursor?.positions || {});
  if (files.length !== 1) return false;
  let compacted = false;
  const prompts = codexPromptProgress();
  hasJsonlEventAfterCursor(files, receipt.cursor, (event) => {
    if (event?.type === "compacted" || (event?.type === "event_msg" && event.payload?.type === "context_compacted")) {
      compacted = true;
      prompts.settle();
    } else if (prompts.see(event) === "processed") compacted = false;
    return false;
  });
  return compacted && !prompts.isOpen();
}

// costHold marks a hold for an unverified compact or unread context, which the owner's message may pass in the queue.
const COST_HOLDS = { "compact-tried": "this context's compact is unverified", "unknown-context": "this context's size or quiet time is unread" };
const heldLaunch = (decision, blocked, detail = null) => Object.assign(new Error(COST_HOLDS[decision.cell]
  ? `Codex resume held: ${decision.cell}: ${COST_HOLDS[decision.cell]}, so automatic work waits${detail ? `: ${detail}` : ""}`
  : `Codex model change blocked: ${decision.cell}: ${blocked?.reason || "previous model unknown"}`), { costHold: Boolean(COST_HOLDS[decision.cell]) });

/** WHAT: Routes one exact Codex session through compact-first launch. WHY: Keeps config changes, wake and recovery behind the same cost boundary as /model. */
export async function launchCodexWithPolicy({
  sessionId, previous, selected, blocked, retry = false, receipt = null, context = "WITHIN", work = "AUTOMATIC",
  launch, compact, reset, verify, remember, recordBlocked,
  validReceipt = validCodexCompactReceipt, log = message => console.warn(`codex launch | ${message}`),
}) {
  const verified = validReceipt(receipt, sessionId);
  const transition = Boolean(sessionId && previous?.model !== selected.model);
  const decideFor = (launchContext, proven = verified) => codexLaunchDecision({ sessionId, previous, selected,
    blocked: transition && blocked?.target === selected.model && !retry && !proven, receipt: proven, context: launchContext, work });
  const decision = decideFor(context);
  if (decision.values.action === "HOLD") throw heldLaunch(decision, blocked);
  // An active goal starts a turn as soon as Codex opens the session, so the
  // launch that only compacts runs with goals off; the next launch resumes it.
  const compactFirst = async () => {
    await launch(previous, { goals: false });
    const proof = await compact();
    if (!validReceipt(proof, sessionId)) throw new Error(`compact not verified: ${proof?.reason || "missing exact-session receipt"}`);
    await reset();
  };
  let action = decision.values.action;
  try {
    if (action === "COMPACT") {
      // A verified compact is a receipt and a failed one a tried context: the
      // table then decides the start. A failed model change stays blocked.
      action = await compactFirst().then(() => decideFor(context, true).values.action, async (error) => {
        if (transition) throw error;
        const tried = decideFor("TRIED");
        if (tried.values.action === "HOLD") throw heldLaunch(tried, blocked, error.message);
        log(`${sessionId}: compact before resume failed, ${tried.cell} opens it uncompacted: ${error.message}`);
        await reset();
        return tried.values.action;
      });
    }
    // A paused goal lets the owner's message run first; the next normal start resumes it.
    await launch(selected, { goals: action === "LAUNCH" });
    const actual = await verify();
    if (actual?.model !== selected.model || (selected.effort && actual?.effort !== selected.effort)) {
      throw new Error(`requested ${selected.model}, running ${actual?.model || "unknown"}`);
    }
    remember(actual);
    return actual;
  } catch (error) {
    // This process was opened only for the guarded transition. Preserve its
    // journal and leave a shell, so a later prompt cannot slip past the gate.
    if (transition) recordBlocked({ target: selected.model, reason: error.message });
    await reset();
    throw error;
  }
}
