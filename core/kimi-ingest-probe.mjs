// Kimi ingest liveness probe: a one-line nonce prompt whose Wire journal
// echo proves the pane actually ingests. The probe is short and single-line,
// so it can never collapse to a `[paste #…]` marker and its exact echo is
// conclusive. The delivery broker calls this on receiptless retries, before
// committing the real payload again.

import { randomBytes } from "node:crypto";
import { stripAnsi } from "../lib.mjs";
import { AMUX_PROBE_PREFIX } from "./kimi-agent-runtime.mjs";

const PROBE_INGEST_TIMEOUT_MS = 10_000;
const PROBE_PASTE_SETTLE_MS = 250;
const PROBE_RECEIPT_POLL_MS = 250;
const PROBE_RESCUE_AFTER_MS = 1_000;
const PROBE_PLAN_VERSION = 1;

function probeText(nonce) {
  return `${AMUX_PROBE_PREFIX}${nonce}`;
}

function normalizeProbePlan(value) {
  if (!value || value.version !== PROBE_PLAN_VERSION || !/^m-[a-f0-9]{8}$/u.test(value.nonce || "")) {
    return null;
  }
  return { version: PROBE_PLAN_VERSION, nonce: value.nonce, cursor: value.cursor ?? null };
}

/** WHAT: Reads Kimi's final visible composer row. WHY: Lets recovery act only on the exact probe it durably owns. */
export function kimiComposerDraft(snapshot) {
  const lines = stripAnsi(String(snapshot || "")).split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = lines[index].match(/^\s*(?:[│┃]\s*)?>[ \t]*(.*?)(?:[ \t]*[│┃])?[ \t]*$/u);
    if (match) return match[1].trimEnd();
  }
  return null;
}

/** WHAT: Builds the Kimi ingest probe over the pane's tmux/journal primitives. WHY: Keeps TUI mechanics out of the broker's delivery policy. */
export function createKimiIngestProbe({
  paneDialectName,
  isBusy,
  captureScreen,
  paneDir,
  agentConfig,
  capturePromptEchoCursor,
  typeLiteral,
  sendEnter,
  promptAccepted,
  wait,
  now = () => Date.now(),
  randomNonce = () => `m-${randomBytes(4).toString("hex")}`,
  ingestTimeoutMs = PROBE_INGEST_TIMEOUT_MS,
  pasteSettleMs = PROBE_PASTE_SETTLE_MS,
  rescueAfterMs = PROBE_RESCUE_AFTER_MS,
}) {
  async function accepted(dir, text, cursor) {
    try { return promptAccepted(dir, text, { cursor }) === true; }
    catch { return false; }
  }

  async function observeComposer(agentName, pane, text) {
    const snapshot = await captureScreen(agentName, pane).catch(() => "");
    const draft = kimiComposerDraft(snapshot);
    if (draft === "") return "empty";
    if (draft === text) return "owned";
    return draft === null ? "unknown" : "foreign";
  }

  async function waitForReceipt(dir, text, cursor, budgetMs) {
    const deadline = now() + Math.max(0, budgetMs);
    while (true) {
      if (await accepted(dir, text, cursor)) return true;
      if (now() >= deadline) return false;
      await wait(Math.min(PROBE_RECEIPT_POLL_MS, Math.max(1, deadline - now())));
    }
  }

  /** WHAT: Checks one pane's liveness with a nonce turn. WHY: Prevents payload retypes into a pane that proves nothing lands. */
  return async function probeIngest(agentName, pane, { prepared = null, onPrepared = null } = {}) {
    if (paneDialectName(agentName, pane) !== "kimi") return { ok: true, skipped: "dialect" };
    let plan = prepared ? normalizeProbePlan(prepared) : null;
    if (prepared && !plan) return { ok: false, reason: "invalid durable probe state" };
    const dir = paneDir(agentConfig(agentName).dir, pane);
    if (plan && await accepted(dir, probeText(plan.nonce), plan.cursor)) {
      return { ok: true, nonce: plan.nonce, recovered: true };
    }
    if (await isBusy(agentName, pane).catch(() => true)) {
      return { ok: false, reason: "agent busy" };
    }

    let text = plan ? probeText(plan.nonce) : null;
    let composer = await observeComposer(agentName, pane, text);
    if (!plan) {
      if (composer !== "empty") return { ok: false, reason: "composer not empty" };
      const nonce = randomNonce();
      if (!/^m-[a-f0-9]{8}$/u.test(nonce)) return { ok: false, reason: "invalid probe nonce" };
      text = probeText(nonce);
      const cursor = await capturePromptEchoCursor(agentName, pane, text);
      plan = { version: PROBE_PLAN_VERSION, nonce, cursor: cursor ?? null };
      if (typeof onPrepared === "function") await onPrepared(plan);
      await typeLiteral(agentName, text, pane);
      await wait(pasteSettleMs);
      composer = await observeComposer(agentName, pane, text);
    } else if (composer === "empty") {
      // The bridge may have crashed after persisting intent but before typing.
      await typeLiteral(agentName, text, pane);
      await wait(pasteSettleMs);
      composer = await observeComposer(agentName, pane, text);
    }

    if (composer !== "owned") {
      return { ok: false, reason: composer === "foreign" ? "composer contains foreign text" : "owned probe draft not visible" };
    }

    await sendEnter(agentName, pane);
    if (await waitForReceipt(dir, text, plan.cursor, Math.min(rescueAfterMs, ingestTimeoutMs))) {
      return { ok: true, nonce: plan.nonce };
    }

    // Kimi treats Enter inside its short paste-burst window as a newline. If
    // the exact owned probe remains, one later Enter is safe; any foreign
    // draft or active turn aborts without touching the composer.
    composer = await observeComposer(agentName, pane, text);
    if (composer === "owned" && !await isBusy(agentName, pane).catch(() => true)) {
      await sendEnter(agentName, pane);
    }
    const remainingMs = Math.max(0, ingestTimeoutMs - Math.min(rescueAfterMs, ingestTimeoutMs));
    if (await waitForReceipt(dir, text, plan.cursor, remainingMs)) {
      return { ok: true, nonce: plan.nonce, recovered: true };
    }
    return { ok: false, reason: `no Wire echo within ${ingestTimeoutMs / 1000}s` };
  };
}
