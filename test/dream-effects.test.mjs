import { afterEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDreamCurationProof } from "../core/dream-curation-proof.mjs";
import { judgeDreamMemory } from "../core/dream-memory-guard.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const temporary = () => { const root = mkdtempSync(join(tmpdir(), "dream-effects-")); roots.push(root); return root; };

it("accepts native Codex completion with dynamic shell arguments when memory is untouched", () => {
  const root = temporary(), path = join(root, "native.jsonl"), sessionId = "original", turnId = "dream-turn";
  const dateKey = "2026-10-24", runId = "original-run", prompt = "Curate the isolated result.";
  const events = [
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "turn_context", payload: { turn_id: turnId, model: "gpt-6.1-sol", effort: "xhigh" } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }], internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } },
    { type: "response_item", payload: { type: "function_call", name: "functions.exec", arguments: JSON.stringify({ code: "const command = ['cat', inputPath].join(' '); await tools.exec_command({ cmd: command });" }) } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `DREAM_OK ${dateKey} ${runId}` }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ];
  // Codex's exec is a custom tool: its body is JavaScript, not a JSON argument object.
  events[3].payload = { type: "custom_tool_call", name: "functions.exec", input: "const command = ['cat', inputPath].join(' '); await tools.exec_command({ cmd: command });" };
  writeFileSync(path, events.map(event => JSON.stringify({ timestamp: "2026-10-24T02:00:00Z", ...event })).join("\n") + "\n");
  expect(readDreamCurationProof({ owner: { engine: "codex", paneDir: root }, sessionId, prompt, dateKey, runId,
    memPath: join(root, "memory", `${dateKey}.md`), quality: { model: "gpt-6.1-sol", effort: "xhigh" }, identityFor: () => ({ path, sessionId }) }).terminal).toBeTruthy();
});

it("lets the curator change the daily memory", () => {
  const path = join(temporary(), "memory.md");
  writeFileSync(path, "Existing human context.\n");
  const before = readFileSync(path, "utf8");
  writeFileSync(path, "Rewritten by the curator.\n");
  expect(judgeDreamMemory(before, readFileSync(path, "utf8")).ok).toBe(true);
});

it("still refuses a corrupted controller marker", () => {
  const block = "<!-- amux-dream-summary:2026-10-24 -->\nx\n<!-- /amux-dream-summary:2026-10-24 -->\n";
  expect(judgeDreamMemory(block, "<!-- amux-dream-summary:2026-10-24 -->\nbroken\n")).toEqual({ ok: false, reason: "dream-marker" });
});
