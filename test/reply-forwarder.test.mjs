import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { extractMatchingReply } from "../core/reply-forwarder.mjs";

function setupFakeCodexTurn({ prompt, reply, paneDir = "/fake/workspace/.agents/9" }) {
  const fakeHome = mkdtempSync(join(tmpdir(), "agentmux-reply-forwarder-test-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const sessionDir = join(fakeHome, ".codex", "sessions", "2026", "05", "10");
  mkdirSync(sessionDir, { recursive: true });
  const timestamp = new Date().toISOString();
  const events = [
    { type: "session_meta", payload: { cwd: paneDir } },
    { type: "event_msg", timestamp, payload: { type: "task_started", turn_id: "T1" } },
    { type: "event_msg", timestamp, payload: { type: "user_message", message: prompt } },
    {
      type: "response_item",
      timestamp,
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: reply }],
      },
    },
    { type: "event_msg", timestamp, payload: { type: "task_complete", turn_id: "T1" } },
  ];
  writeFileSync(
    join(sessionDir, "rollout-2026-05-10T12-42-00-test.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  return {
    paneDir,
    sentAtMs: Date.now(),
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

feature("reply forwarder: Codex panes", () => {
  unit("extracts a matching Codex reply for an amux-orchestrator brief", {
    given: ["a Codex rollout with the ping prompt and a short reply", () => {
      return setupFakeCodexTurn({
        prompt: "[from claw:8]\n\nping från orchestrator — säg hej tillbaka och inget mer",
        reply: "hej",
      });
    }],
    when: ["extracting by brief snippet", ({ paneDir, sentAtMs }) => {
      return extractMatchingReply(
        paneDir,
        sentAtMs,
        (userPrompt) => userPrompt.includes("ping från orchestrator"),
      );
    }],
    then: ["the Codex assistant text is returned", (reply, { cleanup }) => {
      expect(reply).toBe("hej");
      cleanup();
    }],
  });
});
