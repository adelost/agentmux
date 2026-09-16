// Real journals: a large turn sits between an older prompt and the newest one,
// the shape skyvw:5 had on 2026-09-16 when Dream saw only its newest prompt.

import { feature, component, unit, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { claudeProjectDir } from "./claude-paths.mjs";
import { readClaudeTurnsSince, readTailTurnsSince } from "./dream-history.mjs";
import { collectDreamSources } from "./dream-summarizer.mjs";

const LARGE_OUTPUT = "x".repeat(700 * 1024);
const SINCE_MS = Date.parse("2026-09-15T02:00:00Z");

function withFakeHome(write) {
  const root = mkdtempSync(join(tmpdir(), "amux-dream-history-"));
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  const dir = join(root, "work");
  write(root, join(dir, ".agents", "0"));
  return {
    dir,
    cleanup: () => {
      process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const writeJsonl = (file, events) => writeFileSync(file, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
const prompts = (result) => result.sources[0]?.entries.map((item) => item.userPrompt);

feature("Dream reads a pane back to its window start", () => {
  component("reads work before and after a Claude compact rotation", {
    given: ["two recently modified session files for one pane", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-rotated-"));
      const previousHome = process.env.HOME;
      process.env.HOME = root;
      const paneDir = "/workspace/ai/.agents/0";
      const project = join(root, ".claude", "projects", paneDir.replace(/[\/.]/g, "-"));
      mkdirSync(project, { recursive: true });
      const before = join(project, "before-compact.jsonl");
      const after = join(project, "after-compact.jsonl");
      writeFileSync(before, `${JSON.stringify({
        type: "user", timestamp: "2026-07-21T10:00:00Z",
        message: { role: "user", content: "important work before compact" },
      })}\n`);
      writeFileSync(after, `${JSON.stringify({
        type: "user", timestamp: "2026-07-21T11:00:00Z",
        message: { role: "user", content: "follow-up after compact" },
      })}\n`);
      utimesSync(before, new Date("2026-07-21T10:01:00Z"), new Date("2026-07-21T10:01:00Z"));
      utimesSync(after, new Date("2026-07-21T11:01:00Z"), new Date("2026-07-21T11:01:00Z"));
      return { root, previousHome, paneDir };
    }],
    when: ["reading the bounded multi-session window", ({ paneDir }) =>
      readClaudeTurnsSince(paneDir, { since: new Date("2026-07-21T09:00:00Z") })],
    then: ["both sides of compact are present", (result, fx) => {
      expect(result.turns.map((item) => item.userPrompt)).toEqual([
        "important work before compact", "follow-up after compact",
      ]);
      expect(result.filesRead).toBe(2);
      process.env.HOME = fx.previousHome;
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  component("a Codex prompt behind a large tool output is not dropped", {
    given: ["a rollout whose newest prompt fits in the first tail window alone", () => withFakeHome((root, paneDir) => {
      const day = join(root, ".codex", "sessions", "2026", "09", "15");
      mkdirSync(day, { recursive: true });
      const event = (timestamp, payload, type = "event_msg") => ({ timestamp, type, payload });
      writeJsonl(join(day, "rollout-2026-09-15T10-00-00-dream.jsonl"), [
        { type: "session_meta", payload: { cwd: paneDir, source: "cli", originator: "codex-tui" } },
        event("2026-09-15T10:00:00Z", { type: "task_started", turn_id: "A" }),
        event("2026-09-15T10:00:01Z", { type: "user_message", message: "close row 32" }),
        event("2026-09-15T10:30:00Z", { type: "function_call_output", call_id: "c1", output: LARGE_OUTPUT }, "response_item"),
        event("2026-09-15T11:00:00Z", { type: "message", role: "assistant", content: [{ type: "output_text", text: "row 32 released" }] }, "response_item"),
        event("2026-09-15T11:00:01Z", { type: "task_complete", turn_id: "A" }),
        event("2026-09-16T04:05:50Z", { type: "task_started", turn_id: "B" }),
        event("2026-09-16T04:05:54Z", { type: "user_message", message: "take over as orchestrator" }),
        event("2026-09-16T04:06:00Z", { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] }, "response_item"),
        event("2026-09-16T04:06:01Z", { type: "task_complete", turn_id: "B" }),
      ]);
    })],
    when: ["collecting Dream sources from the real journal", ({ dir }) =>
      collectDreamSources([{ name: "skyvw", dir, panes: [{ cmd: "codex" }] }], SINCE_MS)],
    then: ["both prompts since the window start are present", (result, { cleanup }) => {
      expect(result.unreadable).toEqual([]);
      expect(prompts(result)).toEqual(["close row 32", "take over as orchestrator"]);
      cleanup();
    }],
  });

  component("a Claude prompt behind a large tool result is not dropped", {
    given: ["a session whose newest prompt fits in the first tail window alone", () => withFakeHome((root, paneDir) => {
      const project = claudeProjectDir(paneDir, root);
      mkdirSync(project, { recursive: true });
      const user = (timestamp, content) => ({ type: "user", timestamp, message: { role: "user", content } });
      const assistant = (timestamp, content, stop) => ({
        type: "assistant", timestamp, message: { role: "assistant", content, stop_reason: stop },
      });
      writeJsonl(join(project, "session.jsonl"), [
        user("2026-09-15T10:00:00Z", "close row 34"),
        assistant("2026-09-15T10:01:00Z", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "true" } }], "tool_use"),
        user("2026-09-15T10:02:00Z", [{ type: "tool_result", tool_use_id: "t1", content: LARGE_OUTPUT }]),
        assistant("2026-09-15T11:00:00Z", [{ type: "text", text: "row 34 released" }], "end_turn"),
        user("2026-09-16T04:03:12Z", "re-anchor after the restart"),
        assistant("2026-09-16T04:04:00Z", [{ type: "text", text: "nothing hung" }], "end_turn"),
      ]);
    })],
    when: ["collecting Dream sources from the real journal", ({ dir }) =>
      collectDreamSources([{ name: "lsrc", dir, panes: [{ cmd: "claude" }] }], SINCE_MS)],
    then: ["both prompts since the window start are present", (result, { cleanup }) => {
      expect(result.unreadable).toEqual([]);
      expect(prompts(result)).toEqual(["close row 34", "re-anchor after the restart"]);
      cleanup();
    }],
  });

  unit("an unreadable cold record marks the gap instead of hiding the pane forever", {
    given: ["a 64 MiB journal whose tail holds recent work but never reaches the window start", () => {
      const tail = { jsonlFile: "/session.jsonl", turns: [{
        timestamp: "2026-09-16T01:00:00Z", userPrompt: "recent work", isComplete: true,
        items: [{ type: "text", content: "SUMMARY: done" }],
      }] };
      return {
        reader: (_pane, options) => {
          if (options.dreamHistory) throw new Error("dream-history-record-exhausted: oversized unclassified record at byte 21031318");
          return tail;
        },
        stat: () => ({ size: 128 * 1024 * 1024, mtimeMs: Date.parse("2026-09-16T01:00:00Z") }),
      };
    }],
    when: ["reading back to a receipt from two days earlier", ({ reader, stat }) =>
      readTailTurnsSince("codex", "/pane", { since: new Date("2026-09-14T02:00:00Z"), reader, stat })],
    then: ["the tail's work is returned with the gap stated", (result) => {
      expect(result.turns.map((turn) => turn.userPrompt)).toEqual(["recent work"]);
      expect(result.reachedSince).toBe(false);
    }],
  });
});
