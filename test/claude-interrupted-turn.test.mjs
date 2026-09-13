import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBusyFromJsonl } from "../core/jsonl-reader.mjs";

const paneDir = "/fake/skyvw/.agents/2";
const roots = [];
const originalHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = originalHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const prompt = (text) => ({ type: "user", message: { content: text } });
const assistant = (content) => ({ type: "assistant", message: { stop_reason: "tool_use", content } });
const result = (content = "Tool rejected", isError = true) => ({
  type: "user", message: { content: [{ type: "tool_result", tool_use_id: "capture", content, is_error: isError }] },
});
const interruption = (text = "[Request interrupted by user for tool use]") => ({
  type: "user", message: { content: [{ type: "text", text }] },
});

function observe(tail, { hasAssistant = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-interrupted-turn-"));
  roots.push(root);
  process.env.HOME = root;
  const project = join(root, ".claude/projects", paneDir.replace(/[/.]/g, "-"));
  mkdirSync(project, { recursive: true });
  const events = [prompt("Capture the existing HOME states")];
  if (hasAssistant) events.push(assistant([{ type: "tool_use", id: "capture", name: "Bash" }]));
  events.push(...tail);
  writeFileSync(join(project, "session.jsonl"), events.map((event, i) => JSON.stringify({
    ...event, uuid: `event-${i}`, sessionId: "same-session", timestamp: new Date().toISOString(),
  })).join("\n") + "\n");
  return isBusyFromJsonl(paneDir);
}

describe("Claude interruption is a turn boundary, not an outstanding tool result", () => {
  it.each(["[Request interrupted by user for tool use]", "[Request interrupted by user]"])(
    "recognizes the exact engine event %s without needing a later assistant reply", (marker) => {
      // Given a rejected tool followed by Claude's actual interruption record.
      // When observed before any later background notification, then the turn is idle.
      expect(observe([result(), interruption(marker), { type: "system", subtype: "turn_duration" }])).toBe(false);
    },
  );

  it("recognizes cancellation before an assistant response existed", () => {
    // Given cancellation during initial thinking, no assistant reply is owed.
    expect(observe([interruption()], { hasAssistant: false })).toBe(false);
  });

  it.each([
    [result("STOP what you are doing and wait for the user")],
    [result("[Request interrupted by user for tool use]")],
    [assistant([{ type: "text", text: "[Request interrupted by user for tool use]" }])],
    [interruption("[Request interrupted by user for tool use] plus a real question")],
    [result(), { type: "system", subtype: "turn_duration" }],
  ].map((tail) => ({ tail })))("does not turn ordinary errors, quoted markers or duration bookkeeping into idle", ({ tail }) => {
    // Given text without the exact engine interruption shape, then retain the busy guard.
    expect(observe(tail)).toBe(true);
  });

  it.each([
    assistant([{ type: "tool_use", id: "new-work", name: "Bash" }]),
    prompt("Continue now with the safe artifact directory"),
    result("Another tool result"),
    interruption("A new user request in array form"),
  ])("does not let an older interruption override later user or assistant activity", (later) => {
    // Given a real interruption followed by new activity, then do not authorize recovery.
    expect(observe([result(), interruption(), later])).toBe(true);
  });
});
