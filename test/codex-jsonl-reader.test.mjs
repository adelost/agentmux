import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractFromCodexJsonl,
  isBusyFromCodexJsonl,
  isPromptInCodexJsonl,
} from "../core/codex-jsonl-reader.mjs";

/**
 * Build a codex rollout jsonl file at ~/.codex/sessions/2026/04/09/rollout-x.jsonl
 * under a fake HOME. Returns { paneDir, cleanup }.
 *
 * `events` is an array of objects; each one is JSON-stringified per line.
 * The first event should typically be { type:"session_meta", payload:{ cwd } }
 * so the reader can match the pane dir.
 */
function setupFakeCodex(events, paneDir = "/fake/workspace") {
  const fakeHome = mkdtempSync(join(tmpdir(), "agentmux-codex-test-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const sessionDir = join(fakeHome, ".codex", "sessions", "2026", "04", "09");
  mkdirSync(sessionDir, { recursive: true });
  const file = join(sessionDir, "rollout-2026-04-09T10-00-00-abc.jsonl");
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  return {
    paneDir,
    fakeHome,
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

/**
 * Drop a second codex rollout file into the same sessions tree with a
 * different cwd, and set its mtime to be either older or newer than the
 * original. Used for specificity-priority tests.
 */
function addExtraRollout(fakeHome, cwd, name, { mtime, turnId = "T", prompt = "extra" } = {}) {
  const sessionDir = join(fakeHome, ".codex", "sessions", "2026", "04", "09");
  const path = join(sessionDir, name);
  const events = [
    { type: "session_meta", payload: { cwd } },
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "event_msg", payload: { type: "user_message", message: prompt } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `response from ${cwd}` }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
  ];
  writeFileSync(path, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (mtime != null) utimesSync(path, mtime, mtime);
  return path;
}

/** Canonical two-turn rollout: turn A completes, then turn B is the latest. */
function twoTurnRollout(paneDir) {
  return [
    { type: "session_meta", payload: { cwd: paneDir } },
    // Turn A
    { type: "event_msg", payload: { type: "task_started", turn_id: "A" } },
    { type: "event_msg", payload: { type: "user_message", message: "prompt A" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "response A" }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "A" } },
    // Turn B
    { type: "event_msg", payload: { type: "task_started", turn_id: "B" } },
    { type: "event_msg", payload: { type: "user_message", message: "prompt B" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "response B" }] } },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "B" } },
  ];
}

// --- extractFromCodexJsonl -----------------------------------------------

feature("extractFromCodexJsonl: single-turn rollout", () => {
  unit("returns assistant text + tool calls for the only turn", {
    given: ["rollout with assistant text and a function_call", () => {
      const paneDir = "/fake/workspace";
      return setupFakeCodex([
        { type: "session_meta", payload: { cwd: paneDir } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "T1" } },
        { type: "event_msg", payload: { type: "user_message", message: "list files" } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll list them." }] } },
        { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "ls" }) } },
        { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } },
        { type: "event_msg", payload: { type: "task_complete", turn_id: "T1" } },
      ], paneDir);
    }],
    when: ["extracting", ({ paneDir }) => extractFromCodexJsonl(paneDir, "list files")],
    then: ["three items in order: text, tool, text", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items).toHaveLength(3);
      expect(result.items[0]).toEqual({ type: "text", content: "I'll list them." });
      expect(result.items[1].type).toBe("tool");
      expect(result.items[1].content).toContain("Bash ls");
      expect(result.items[2]).toEqual({ type: "text", content: "Done." });
      cleanup();
    }],
  });
});

feature("extractFromCodexJsonl: prompt-matching across multiple turns", () => {
  unit("returns turn A when A's prompt text is given, even though B is newer", {
    given: ["two-turn rollout", () => setupFakeCodex(twoTurnRollout("/fake/workspace"))],
    when: ["extracting with the older prompt", ({ paneDir }) => extractFromCodexJsonl(paneDir, "prompt A")],
    then: ["returns A's content, not B's", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toBe("response A");
      cleanup();
    }],
  });

  unit("returns turn B when B's prompt text is given", {
    given: ["two-turn rollout", () => setupFakeCodex(twoTurnRollout("/fake/workspace"))],
    when: ["extracting with the newer prompt", ({ paneDir }) => extractFromCodexJsonl(paneDir, "prompt B")],
    then: ["returns B's content", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toBe("response B");
      cleanup();
    }],
  });

  unit("returns the last turn when no prompt text is given", {
    given: ["two-turn rollout", () => setupFakeCodex(twoTurnRollout("/fake/workspace"))],
    when: ["extracting with null needle", ({ paneDir }) => extractFromCodexJsonl(paneDir, null)],
    then: ["returns B's content (most recent)", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items[0].content).toBe("response B");
      cleanup();
    }],
  });

  unit("returns null when prompt text doesn't match any turn", {
    given: ["two-turn rollout", () => setupFakeCodex(twoTurnRollout("/fake/workspace"))],
    when: ["extracting with a bogus prompt", ({ paneDir }) => extractFromCodexJsonl(paneDir, "never sent")],
    then: ["null, do not fall back to latest turn", (result, { cleanup }) => {
      expect(result).toBeNull();
      cleanup();
    }],
  });
});

// --- isBusyFromCodexJsonl + isPromptInCodexJsonl ------------------------

feature("isBusyFromCodexJsonl: task lifecycle", () => {
  unit("returns false when all tasks have task_complete", {
    given: ["two completed turns", () => setupFakeCodex(twoTurnRollout("/fake/workspace"))],
    when: ["checking busy", ({ paneDir }) => isBusyFromCodexJsonl(paneDir)],
    then: ["idle", (r, { cleanup }) => {
      expect(r).toBe(false);
      cleanup();
    }],
  });

  unit("returns true when the latest task has no task_complete", {
    given: ["started but unfinished turn", () => {
      const paneDir = "/fake/workspace";
      return setupFakeCodex([
        { type: "session_meta", payload: { cwd: paneDir } },
        { type: "event_msg", payload: { type: "task_started", turn_id: "X" } },
        { type: "event_msg", payload: { type: "user_message", message: "ongoing" } },
        // no task_complete yet
      ], paneDir);
    }],
    when: ["checking busy", ({ paneDir }) => isBusyFromCodexJsonl(paneDir)],
    then: ["busy", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

feature("latestSessionFor: cwd specificity", () => {
  unit("prefers exact cwd match over a newer ancestor cwd", {
    given: ["ancestor session /workspace (newer), exact session /workspace/pane (older)", () => {
      const paneDir = "/workspace/pane";
      const ctx = setupFakeCodex([
        // The "main" rollout setup creates a file at paneDir /fake/workspace. We
        // don't want that matching, so set paneDir to something else entirely.
        { type: "session_meta", payload: { cwd: "/unrelated" } },
      ], paneDir);
      // Exact match in a quieter file (older)
      addExtraRollout(ctx.fakeHome, "/workspace/pane", "rollout-exact.jsonl",
        { mtime: 1_000, prompt: "exact-prompt" });
      // Ancestor match in a newer file, would win by mtime alone
      addExtraRollout(ctx.fakeHome, "/workspace", "rollout-ancestor.jsonl",
        { mtime: 2_000, prompt: "ancestor-prompt" });
      return ctx;
    }],
    when: ["extracting with a needle only the exact file has",
      ({ paneDir }) => extractFromCodexJsonl(paneDir, "exact-prompt")],
    then: ["returns exact-match content, not newer ancestor", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items[0].content).toBe("response from /workspace/pane");
      cleanup();
    }],
  });

  unit("prefers closer ancestor over more distant ancestor", {
    given: ["two ancestors at different depths", () => {
      const paneDir = "/a/b/c/d";
      const ctx = setupFakeCodex([
        { type: "session_meta", payload: { cwd: "/unrelated" } },
      ], paneDir);
      // Far ancestor, newer
      addExtraRollout(ctx.fakeHome, "/a", "rollout-far.jsonl",
        { mtime: 2_000, prompt: "far-prompt" });
      // Close ancestor, older. Should still win by specificity
      addExtraRollout(ctx.fakeHome, "/a/b/c", "rollout-close.jsonl",
        { mtime: 1_000, prompt: "close-prompt" });
      return ctx;
    }],
    when: ["extracting with no needle (let latestSessionFor pick)",
      ({ paneDir }) => extractFromCodexJsonl(paneDir, null)],
    then: ["picks the closer ancestor", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items[0].content).toBe("response from /a/b/c");
      cleanup();
    }],
  });

  unit("does not match a descendant cwd (another codex inside the workspace)", {
    given: ["pane /workspace, session started inside /workspace/sub", () => {
      const paneDir = "/workspace";
      const ctx = setupFakeCodex([
        { type: "session_meta", payload: { cwd: "/unrelated" } },
      ], paneDir);
      // Descendant session, must NOT match
      addExtraRollout(ctx.fakeHome, "/workspace/sub", "rollout-desc.jsonl",
        { mtime: 2_000, prompt: "desc-prompt" });
      return ctx;
    }],
    when: ["extracting with descendant prompt",
      ({ paneDir }) => extractFromCodexJsonl(paneDir, "desc-prompt")],
    then: ["returns null, descendant is not our pane's session", (result, { cleanup }) => {
      expect(result).toBeNull();
      cleanup();
    }],
  });
});

feature("isPromptInCodexJsonl", () => {
  unit("finds a prompt in the user_message events", {
    given: ["two-turn rollout", () => setupFakeCodex(twoTurnRollout("/fake/workspace"))],
    when: ["checking", ({ paneDir }) => isPromptInCodexJsonl(paneDir, "prompt A")],
    then: ["found", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });

  unit("returns false when the prompt was never sent", {
    given: ["two-turn rollout", () => setupFakeCodex(twoTurnRollout("/fake/workspace"))],
    when: ["checking", ({ paneDir }) => isPromptInCodexJsonl(paneDir, "never sent")],
    then: ["not found", (r, { cleanup }) => {
      expect(r).toBe(false);
      cleanup();
    }],
  });
});
