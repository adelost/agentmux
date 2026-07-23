// THE delivery contract. Every path that puts text into an agent pane —
// Discord prompts, Discord slash commands, CLI briefs (amux <agent> "..."),
// dream/auto-compact /compact — routes through here, so the guarantees
// live in exactly one place:
//
//   1. Blocking prompts are dismissed before sending.
//   2. Delivery is VERIFIED at the source of truth, never assumed: prompts
//      only against the session JSONL; slash commands against the composer
//      being consumed (they intentionally never reach JSONL).
//   3. Failures are rescued (submit-Enter) and retried idempotently.
//   4. The verdict is HONEST: { delivered: false } means the human/caller
//      must be told — no path may claim success it cannot prove.
//
// Born from two real incidents (2026-07-08): a prompt that sat unsubmitted
// in an idle composer while the bridge logged "delivered", and a /model
// that could vanish into the command palette while Discord said "sent".

import { appendEvent } from "./events.mjs";
import { rewriteModelSlash } from "./claude-model.mjs";
import { detectSlashTerminalRejection } from "./slash-ingest-guard.mjs";

/**
 * Delivery receipt: every verified send leaves a ledger row, so "did my
 * message arrive?" is an `amux timeline --grep` instead of a forensic dig
 * through pane jsonl (the ai:4 excavation, 2026-07-08). Best-effort by
 * design: a failed receipt write must never fail the delivery itself.
 */
function recordReceipt(agentName, pane, kind, text, result) {
  try {
    appendEvent({
      ts: new Date().toISOString(),
      event: "delivery",
      session: agentName,
      pane: Number(pane) || 0,
      kind, // "prompt" | "slash"
      delivered: Boolean(result.delivered),
      via: result.via ?? null,
      attempts: result.attempts ?? null,
      rescues: result.rescues ?? null,
      blocked: Boolean(result.blocked),
      pending: Boolean(result.pending),
      transportHint: result.transportHint ? String(result.transportHint).slice(0, 160) : null,
      reason: result.reason ? String(result.reason).slice(0, 160) : null,
      detail: String(text).slice(0, 120),
    });
  } catch { /* receipts are diagnostics, not delivery */ }
}

/**
 * Route by payload shape: Claude-internal slash commands need composer
 * verification, prompts get jsonl echo verification.
 */
export async function deliverToPane(agent, agentName, pane, text, opts = {}) {
  const resolved = rewriteModelSlash(text);
  return isSlashCommand(resolved)
    ? sendSlashVerified(agent, agentName, pane, resolved.trim(), opts)
    : sendPromptVerified(agent, agentName, pane, resolved, opts);
}

/** "/model fable" yes; "/home/x/file" no (path, not command). */
export function isSlashCommand(text) {
  return /^\/[a-z][\w-]*(\s|$)/i.test(String(text).trimStart());
}

/**
 * Verified prompt delivery: dismiss -> send -> echo-verify -> retry.
 * sendText is what goes into the pane (may carry a "[from x]" prefix);
 * verifyText is what the echo check looks for (the bare prompt).
 * Returns { delivered, attempts, via } — prompt delivery is acknowledged only
 * by the exact session-JSONL echo. Composer/queue observations are retained as
 * transport hints, but may never produce a delivered or blocked verdict.
 */
export async function sendPromptVerified(agent, agentName, pane, text, opts = {}) {
  const result = await promptDeliveryAttempts(agent, agentName, pane, text, opts);
  if (!opts.suppressReceipt) recordReceipt(agentName, pane, "prompt", opts.verifyText ?? text, result);
  return result;
}

async function promptDeliveryAttempts(agent, agentName, pane, text, {
  verifyText = null, attempts = 3, echoTimeoutMs = 6000, log = () => {},
  echoCursor: suppliedEchoCursor = null,
  precheckEcho = false,
  notBeforeMs: suppliedNotBeforeMs = null,
  knownDrafted = false,
  onPasteStarted = null,
  onDrafted = null,
  onSubmitting = null,
  onSubmitted = null,
} = {}) {
  const target = `${agentName}:.${pane}`;
  const needle = verifyText ?? text;
  // A repeated prompt must produce a NEW jsonl event. Without this cursor,
  // an identical historical "test" or recovery prompt makes a lost send look
  // acknowledged immediately.
  const parsedCursor = Number(suppliedNotBeforeMs);
  const hasTimestampCursor = suppliedNotBeforeMs != null
    && Number.isFinite(parsedCursor) && parsedCursor > 0;
  const notBeforeMs = hasTimestampCursor ? parsedCursor : Date.now();
  let echoCursor = suppliedEchoCursor;
  if (!echoCursor && typeof agent.capturePromptEchoCursor === "function") {
    try { echoCursor = await agent.capturePromptEchoCursor(agentName, pane, needle); }
    catch (error) { log(`prompt cursor capture failed; using local timestamp: ${error.message}`); }
  }
  const echoOptions = echoCursor ? { cursor: echoCursor } : { notBeforeMs };

  // A durable Discord replay reuses the event-identity cursor captured before
  // its FIRST pane write. If that earlier attempt eventually reached JSONL,
  // acknowledge it before touching the composer again. Legacy timestamp
  // callers keep their existing precheck until all integrations migrate.
  if (precheckEcho || hasTimestampCursor) {
    const alreadyEchoed = await agent.waitForPromptEcho(agentName, pane, needle, 0, echoOptions);
    if (alreadyEchoed) return { delivered: true, attempts: 0, via: "echo" };
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await agent.dismissBlockingPrompt(target)
      .catch((err) => log(`dismiss attempt ${attempt} failed: ${err.message}`));
    // A thrown send must NOT abort the loop — delivery is judged by the
    // echo check, not tmux's exit code (a user scrolling the pane can make
    // tmux error a command that actually landed; see handlers history).
    let sendError = null;
    let sendReceipt = null;
    await agent.sendOnly(agentName, text, pane, {
      knownDrafted,
      onPasteStarted,
      onDrafted,
      onSubmitting,
      onSubmitted,
    })
      .then((receipt) => { sendReceipt = receipt || null; })
      .catch((err) => {
        sendError = err;
        log(`send attempt ${attempt} errored${err.code === "AMUX_DELIVERY_BLOCKED" ? " (blocked, durable queue retries)" : " (verifying echo anyway)"}: ${err.message.split("\n").slice(0, 2).join(" | ")}`);
      });

    // A composer error is only a TUI hint: the previous attempt may already
    // have submitted while the repaint lied. Recheck the authoritative sink
    // before returning, and never let scraping create the delivery verdict.
    if (sendError?.code === "AMUX_DELIVERY_BLOCKED") {
      const echoed = await agent.waitForPromptEcho(agentName, pane, needle, 0, echoOptions);
      if (echoed) return { delivered: true, attempts: attempt, via: "echo" };
      return {
        delivered: false,
        attempts: attempt,
        via: null,
        transportHint: sendError.message,
        ...(sendError.zoomRecoverable ? { zoomRecoverable: true } : {}),
      };
    }

    const echoWaitMs = sendReceipt?.queued ? Math.min(echoTimeoutMs, 1_000) : echoTimeoutMs;
    const echoed = await agent.waitForPromptEcho(agentName, pane, needle, echoWaitMs, echoOptions);
    if (echoed) return { delivered: true, attempts: attempt, via: "echo" };

    // A physical Enter may be followed by a late JSONL event (especially a
    // busy Codex steering turn). Do not duplicate the pane write, but do not
    // call it delivered either: composer/queue state is diagnostic only.
    if (sendReceipt?.submitted || sendReceipt?.queued) {
      return {
        delivered: false,
        attempts: attempt,
        via: null,
        pending: true,
        transportHint: sendReceipt.tuiHint
          || (sendReceipt.queued ? "queue-observed" : "submit-key-sent"),
      };
    }

    if (attempt < attempts) log(`prompt not echoed (attempt ${attempt}/${attempts}), retrying`);
  }
  return { delivered: false, attempts, via: null };
}

/**
 * Verified slash-command delivery (/model, /compact, ...). Slash commands
 * never appear in the session jsonl and typing "/" opens Claude's command
 * palette, which can eat the submitting Enter mid-render. Verification is
 * terminal-side: if the composer region still shows the command after a
 * settle, rescue with another Enter (a bare Enter on an empty composer is
 * a no-op, so a false "stuck" read is harmless).
 * Returns { delivered, rescues }.
 */
export async function sendSlashVerified(agent, agentName, pane, claudeCmd, opts = {}) {
  const result = await slashDeliveryAttempts(agent, agentName, pane, claudeCmd, opts);
  if (!opts.suppressReceipt) recordReceipt(agentName, pane, "slash", claudeCmd, result);
  return result;
}

async function slashDeliveryAttempts(agent, agentName, pane, claudeCmd, {
  settleMs = 1200, maxRescues = 2,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  echoCursor: suppliedReceiptCursor = null,
  notBeforeMs: suppliedNotBeforeMs = null,
  knownDrafted = false,
  onPasteStarted = null,
  onDrafted = null,
  onSubmitting = null,
  onSubmitted = null,
} = {}) {
  const target = `${agentName}:.${pane}`;
  const notBeforeMs = Number(suppliedNotBeforeMs) > 0
    ? Number(suppliedNotBeforeMs)
    : Date.now();
  let receiptCursor = suppliedReceiptCursor;
  if (!receiptCursor && typeof agent.captureSlashReceiptCursor === "function") {
    try { receiptCursor = await agent.captureSlashReceiptCursor(agentName, pane, claudeCmd); }
    catch { /* legacy TUI verification remains available below */ }
  }
  const hasAuthoritativeReceipt = Boolean(
    receiptCursor && typeof agent.waitForSlashReceipt === "function",
  );
  const receiptOptions = receiptCursor ? { cursor: receiptCursor } : { notBeforeMs };
  await agent.dismissBlockingPrompt(target).catch(() => {});
  // Fingerprint the tail before our submit so a stale refusal line already on
  // screen can never be attributed to this attempt. The authoritative Claude
  // receipt path never scrapes the pane, so it takes no fingerprint.
  const beforeTail = hasAuthoritativeReceipt
    ? { ok: true, text: "" }
    : await captureComposerTail(agent, agentName, pane);
  await agent.sendOnly(agentName, claudeCmd, pane,
    { knownDrafted, onPasteStarted, onDrafted, onSubmitting, onSubmitted });

  for (let attempt = 0; attempt <= maxRescues; attempt++) {
    await sleep(settleMs);
    if (hasAuthoritativeReceipt) {
      if (await agent.waitForSlashReceipt(
        agentName, pane, claudeCmd, 0, receiptOptions,
      )) {
        return { delivered: true, rescues: attempt, via: "command-receipt" };
      }
      // The Claude command palette can hide the command after consuming the
      // first Enter while leaving the selected action pending. A bare Enter on
      // an idle composer is harmless; rescue until the exact JSONL event exists.
      if (attempt < maxRescues) await agent.sendEnter(agentName, pane);
      continue;
    }
    const paneTail = await captureComposerTail(agent, agentName, pane);
    // An explicit engine rejection is terminal truth: the command left the
    // composer and was refused. Checking it before the needle match matters,
    // because the refusal line itself echoes the needle ("Unrecognized
    // command: /compat. Did you mean /compact?") and fed 24 blind retries
    // in the 2026-07-22 incident. The before-submit fingerprint binds the
    // verdict to a refusal line that is new for this attempt; without a
    // readable fingerprint the classifier never terminalizes.
    const rejection = detectSlashTerminalRejection(paneTail.text, claudeCmd, {
      beforeText: beforeTail.text,
      fingerprintOk: beforeTail.ok,
    });
    if (rejection) {
      return { delivered: false, rescues: attempt, failed: "not-ingested", reason: rejection.reason };
    }
    if (!stuckInComposer(paneTail.text, claudeCmd)) {
      return { delivered: true, rescues: attempt };
    }
    if (attempt < maxRescues) await agent.sendEnter(agentName, pane);
  }
  return { delivered: false, rescues: maxRescues };
}

/** Capture the composer tail once per rescue decision; unreadable is explicit, never a silent empty string. */
async function captureComposerTail(agent, agentName, pane) {
  try {
    return { ok: true, text: await agent.capturePane(agentName, pane, 12) };
  } catch {
    return { ok: false, text: "" }; // pane unreadable: nothing more a rescue-Enter could do
  }
}

/** The command text still sits in the composer region (last few lines). */
function stuckInComposer(text, claudeCmd) {
  const needle = claudeCmd.slice(0, 30);
  // Only the tail (composer region): scrollback legitimately echoes the
  // command as transcript output after successful execution.
  return String(text).split("\n").slice(-4).some((line) => line.includes(needle));
}
