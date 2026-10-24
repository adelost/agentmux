import { statSync } from "node:fs";
import { persistedSessionIdentity } from "./native-session-identity.mjs";
import { describeSearchEvent, readSearchRecords } from "./search-jsonl.mjs";
import { normalizePrompt, promptEventMatches } from "./claude-prompt-text.mjs";
import { toolCallTexts } from "./dream-memory-race.mjs";
import { launchModelId } from "./pane-model-state.mjs";
import { observationFromCodexEntry } from "./native-model-observation.mjs";

const MAX_JOURNAL_BYTES = 256 * 1024 * 1024;
const MAX_TOOL_BYTES = 8 * 1024 * 1024;

/** WHAT: Checks one completed Dream task in its original journal. WHY: Prevents later work or today's pane state from replacing original terminal evidence. */
export function readDreamCurationProof({ owner, sessionId, prompt, dateKey, runId, memPath, quality, sandbox = false,
  identityFor = persistedSessionIdentity, records = readSearchRecords }) {
  const identity = identityFor(owner.engine, sessionId, owner.paneDir);
  if (!identity?.path || identity.sessionId !== sessionId) throw new Error("dream-curator-journal-unknown");
  const expected = `DREAM_OK ${dateKey} ${runId}`, needle = normalizePrompt(prompt);
  const endByteOffset = Math.min(statSync(identity.path).size, MAX_JOURNAL_BYTES);
  let started = null, terminal = null, toolBytes = 0, observedQuality = null;
  let pendingTurnId = null, pendingQuality = null, sandboxDenied = false;
  const ownerTexts = [];
  for (const record of records(identity.path, { endByteOffset })) {
    if (!record.raw) {
      if (started && !terminal) throw new Error("dream-curator-journal-incomplete");
      continue;
    }
    let event;
    try { event = JSON.parse(record.raw); } catch {
      if (started && !terminal) throw new Error("dream-curator-journal-incomplete");
      continue;
    }
    // Provider request snapshots repeat messages; they are neither an authored turn nor its terminal receipt.
    if (event.isSidechain || event.type === "api-request-blob") continue;
    const observation = owner.engine === "codex" && observationFromCodexEntry(event);
    const startsCodexTurn = owner.engine === "codex" && event.type === "event_msg" && event.payload?.type === "task_started";
    const item = describeSearchEvent(event);
    const matches = owner.engine === "claude"
      ? promptEventMatches(event, prompt)
      : item.role === "USER" && normalizePrompt(item.text) === needle;
    if (!started) {
      if (startsCodexTurn) { pendingTurnId = event.payload.turn_id || null; pendingQuality = null; }
      if (observation && pendingTurnId && observation.turnId === pendingTurnId) pendingQuality = observation;
      if (matches) {
        started = { at: item.date, line: record.line, byteOffset: record.byteOffset, turnId: pendingTurnId };
        // Modern Codex writes task_started/context before the authored input.
        // Only their shared native turn ID authorizes that earlier observation.
        observedQuality = pendingQuality;
      }
      continue;
    }
    if (started.turnId && ((startsCodexTurn && event.payload.turn_id !== started.turnId)
        || (observation && observation.turnId !== started.turnId))) throw new Error("dream-original-turn-mismatch");
    if (observation) observedQuality = observation;
    if (sandbox && event.type === "response_item" && ["function_call_output", "custom_tool_call_output"].includes(event.payload?.type)) {
      const output = typeof event.payload.output === "string" ? event.payload.output : JSON.stringify(event.payload.output);
      if (/(?:read-only file system|sandbox.{0,40}(?:denied|refused)|operation not permitted)/iu.test(output || "")
        && /(?:exit(?:ed)?(?: with)?(?: code)?[:\s]+[1-9]|"exit_code"\s*:\s*[1-9]|error|failed)/iu.test(output || "")) sandboxDenied = true;
    }
    if (item.role === "USER" && item.text && !matches) {
      // Tool-result arrays and engine bookkeeping do not start authored turns.
      const authored = owner.engine === "claude" ? typeof event.message?.content === "string" : true;
      if (authored) break;
    }
    for (const text of toolCallTexts(event, { includeCalls: true })) {
      toolBytes += Buffer.byteLength(text);
      if (toolBytes > MAX_TOOL_BYTES) throw new Error("dream-curator-tool-window-too-large");
      if (terminal) throw new Error(`dream-curator-tool-after-final:${identity.path}:${record.line}`);
      ownerTexts.push(text);
    }
    if (item.role === "ASSI" && item.text.trim() === expected) {
      terminal = { at: item.date, line: record.line, byteOffset: record.byteOffset };
      if (owner.engine === "claude" && event.message?.stop_reason === "end_turn") {
        if (quality && (launchModelId(event.message.model) !== launchModelId(quality.model)
            || String(event.perTurnEffort ?? event.effort) !== quality.effort)) {
          throw new Error("dream-original-session-quality-mismatch");
        }
        return { ownerTexts, started, terminal, sessionId, path: identity.path, sandboxDenied };
      }
    }
    if ((terminal || sandboxDenied) && event.type === "event_msg" && event.payload?.type === "task_complete") {
      if (started.turnId && event.payload.turn_id !== started.turnId) throw new Error("dream-original-turn-mismatch");
      if (quality && (observedQuality?.model !== quality.model || observedQuality?.effort !== quality.effort)) {
        throw new Error("dream-original-session-quality-mismatch");
      }
      return { ownerTexts, started, terminal: terminal || { at: item.date, line: record.line, byteOffset: record.byteOffset, expectedReply: false }, sessionId, path: identity.path, sandboxDenied };
    }
  }
  throw new Error("dream-original-terminal-receipt-unverified");
}
