import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDreamCurationProof } from "../core/dream-curation-proof.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ writeMemory = false, receipt = true, laterWrite = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dream-native-proof-")); roots.push(root);
  const path = join(root, "journal.jsonl"), memPath = join(root, "memory", "2026-10-15.md");
  mkdirSync(join(root, "memory"));
  const dateKey = "2026-10-15", runId = "f12fc8d9-5107-47fb-a7e7-022bc95bf7c7", sessionId = "exact-owner";
  const prompt = `[AMUX DREAM ${dateKey} · run ${runId}]\nRead the original input. Write only the isolated summary.`;
  const at = "2026-10-15T02:24:52.795Z";
  const tool = (name, input) => ({ type: "assistant", timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
  const events = [
    // The real 15 October prompt exists as a queue-operation, not a user message.
    { type: "queue-operation", operation: "enqueue", timestamp: at, content: `\n\n<pasted_content id="c808">\n${prompt}\n</pasted_content id="c808">\n` },
    tool("Bash", { command: `cd ${root}/memory; sed -n '1,20p' 2026-10-15.md; grep -i decision 2026-10-15.md 2>/dev/null` }),
    tool("Write", { file_path: writeMemory ? memPath : join(root, "isolated.summary.md"), content: "A verified decision." }),
    { type: "assistant", timestamp: "2026-10-15T02:29:46.583Z", message: { role: "assistant", stop_reason: "end_turn", model: "claude-opus-5-5",
      content: [{ type: "text", text: receipt ? `DREAM_OK ${dateKey} ${runId}` : "I saw a quoted DREAM_OK." }] }, effort: "max" },
    ...(laterWrite ? [tool("Write", { file_path: memPath, content: "Later independent work, after completion." })] : []),
  ];
  writeFileSync(path, events.map(e => JSON.stringify(e)).join("\n") + "\n");
  return { owner: { agent: "dream", pane: 0, paneDir: root, engine: "claude" }, path, memPath, dateKey, runId, prompt, sessionId,
    quality: { model: "Opus 5.5", effort: "max" }, identityFor: () => ({ path, sessionId }) };
}

describe("original native Dream proof", () => {
  it("ignores request snapshots as inputs or terminal evidence", () => {
    const fx = fixture();
    const events = readFileSync(fx.path, "utf8").trim().split("\n").map(JSON.parse);
    events.splice(1, 0, { type: "api-request-blob", message: { role: "user", content: "A cached request, not a new user turn." } });
    writeFileSync(fx.path, events.map(JSON.stringify).join("\n") + "\n");
    expect(readDreamCurationProof(fx).terminal.line).toBe(5);
    events[4].type = "api-request-blob";
    writeFileSync(fx.path, events.map(JSON.stringify).join("\n") + "\n");
    expect(() => readDreamCurationProof(fx)).toThrow("terminal-receipt-unverified");
  });
  it("binds Codex context written before its user prompt to that same native turn", () => {
    const fx = fixture(), turnId = "native-dream-turn";
    const events = [
      { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      { type: "turn_context", payload: { turn_id: turnId, model: "gpt-6.1-sol", effort: "xhigh" } },
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: fx.prompt }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } },
      { type: "response_item", payload: { type: "message", role: "assistant",
        content: [{ type: "output_text", text: `DREAM_OK ${fx.dateKey} ${fx.runId}` }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ].map(event => ({ timestamp: "2026-10-15T10:08:33Z", ...event }));
    const options = { ...fx, owner: { ...fx.owner, engine: "codex" }, quality: { model: "gpt-6.1-sol", effort: "xhigh" } };
    const save = () => writeFileSync(fx.path, events.map(JSON.stringify).join("\n") + "\n");
    save();
    expect(readDreamCurationProof(options).terminal.line).toBe(4);
    events[1].payload.turn_id = "old-unrelated-turn";
    save();
    expect(() => readDreamCurationProof(options)).toThrow("quality-mismatch");
    events[1].payload.turn_id = turnId;
    events[4].payload.turn_id = "another-completed-turn";
    save();
    expect(() => readDreamCurationProof(options)).toThrow("turn-mismatch");
  });

  it("requires the Codex turn's observed quality and native completion after its final answer", () => {
    const fx = fixture();
    const events = [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: fx.prompt }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } },
      { type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "xhigh" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `DREAM_OK ${fx.dateKey} ${fx.runId}` }] } },
      { type: "event_msg", payload: { type: "task_complete" } },
    ].map(event => ({ timestamp: "2026-10-15T02:30:00Z", ...event }));
    const options = { ...fx, owner: { ...fx.owner, engine: "codex" }, quality: { model: "gpt-6.1-sol", effort: "xhigh" } };
    writeFileSync(fx.path, events.map(e => JSON.stringify(e)).join("\n") + "\n");
    expect(readDreamCurationProof(options).terminal.line).toBe(3);
    writeFileSync(fx.path, events.slice(0, -1).map(e => JSON.stringify(e)).join("\n") + "\n");
    expect(() => readDreamCurationProof(options)).toThrow("terminal-receipt-unverified");
  });
  it("joins the 15 October queued prompt to its exact native end-turn receipt", () => {
    const proof = readDreamCurationProof(fixture({ laterWrite: true }));
    expect(proof.ownerTexts).toHaveLength(2);
    expect(proof.started.at).toBe("2026-10-15T02:24:52.795Z");
    expect(proof.terminal.at).toBe("2026-10-15T02:29:46.583Z");
  });
  it("leaves memory effects to the filesystem guard, not tool-call interpretation", () => {
    expect(readDreamCurationProof(fixture({ writeMemory: true })).terminal).toBeTruthy();
  });
  it("does not turn queue delivery or quoted completion into a native final receipt", () => {
    expect(() => readDreamCurationProof(fixture({ receipt: false }))).toThrow("terminal-receipt-unverified");
  });
  it("verifies the original model and effort rather than today's live pane", () => {
    const fx = fixture();
    expect(() => readDreamCurationProof({ ...fx, quality: { model: "Sonnet 5", effort: "max" } })).toThrow("quality-mismatch");
  });
});
