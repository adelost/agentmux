// Kimi ingest liveness probe: a one-line nonce prompt whose Wire journal
// echo proves the pane actually ingests. The probe is short and single-line,
// so it can never collapse to a `[paste #…]` marker and its exact echo is
// conclusive. The delivery broker calls this on receiptless retries, before
// committing the real payload again.

import { randomBytes } from "node:crypto";
import { AMUX_PROBE_PREFIX, isKimiComposerReady } from "./kimi-agent-runtime.mjs";

const PROBE_INGEST_TIMEOUT_MS = 10_000;

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
}) {
  /** WHAT: Checks one pane's liveness with a nonce turn. WHY: Prevents payload retypes into a pane that proves nothing lands. */
  return async function probeIngest(agentName, pane) {
    if (paneDialectName(agentName, pane) !== "kimi") return { ok: true, skipped: "dialect" };
    if (await isBusy(agentName, pane).catch(() => true)) {
      return { ok: false, reason: "agent busy" };
    }
    const snapshot = await captureScreen(agentName, pane).catch(() => "");
    if (!isKimiComposerReady(snapshot)) {
      return { ok: false, reason: "composer not empty" };
    }
    const nonce = `m-${randomBytes(4).toString("hex")}`;
    const text = `${AMUX_PROBE_PREFIX}${nonce} (transporttest, ignorera, svara inget)`;
    const dir = paneDir(agentConfig(agentName).dir, pane);
    const cursor = await capturePromptEchoCursor(agentName, pane, text);
    await typeLiteral(agentName, text, pane);
    await sendEnter(agentName, pane);
    const deadline = Date.now() + PROBE_INGEST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if (promptAccepted(dir, text, { cursor }) === true) {
          return { ok: true, nonce };
        }
      } catch { /* journal not readable yet — keep polling within budget */ }
      await wait(500);
    }
    return { ok: false, reason: `no Wire echo within ${PROBE_INGEST_TIMEOUT_MS / 1000}s` };
  };
}
