import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  extractFromCodexJsonl,
  isBusyFromCodexJsonl,
  isPromptInCodexJsonl,
  readLastTurnsCodex,
  latestCodexJsonlMtime,
  latestCodexSessionFor,
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
      expect(result.items[1].content).toContain("Run ls");
      expect(result.items[2]).toEqual({ type: "text", content: "Done." });
      cleanup();
    }],
  });

  unit("renders modern custom exec tool calls instead of dropping them", {
    given: ["a codex custom_tool_call wrapping exec_command", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "T2" } },
      { type: "event_msg", payload: { type: "user_message", message: "check status" } },
      { type: "response_item", payload: {
        type: "custom_tool_call",
        name: "exec",
        input: 'const r = await tools.exec_command({cmd:"amux ps",workdir:"/tmp"}); text(r.output);',
      } },
      { type: "response_item", payload: {
        type: "custom_tool_call",
        name: "exec",
        input: 'const r = await tools.exec_command({cmd:"amux lsrc -p 0 \\\"review every image\\\"",workdir:"/tmp"}); text(r.output);',
      } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "T2" } },
    ])],
    when: ["reading the turn", ({ paneDir }) => readLastTurnsCodex(paneDir, { limit: 1 })],
    then: ["the semantic Run call remains visible", (result, { cleanup }) => {
      expect(result.turns[0].items[0]).toMatchObject({ type: "tool", content: "Run amux ps", kind: "tool" });
      expect(result.turns[0].items[1]).toMatchObject({ type: "tool", kind: "inter-agent-send" });
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

// --- readLastTurnsCodex -------------------------------------------------

feature("readLastTurnsCodex: single-turn complete rollout", () => {
  unit("returns one complete turn with text + tool items", {
    given: ["rollout with assistant text and function_call", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:00Z", payload: { type: "task_started", turn_id: "T1" } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:01Z", payload: { type: "user_message", message: "do the thing" } },
      { type: "response_item", timestamp: "2026-04-09T10:00:05Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "starting work" }] } },
      { type: "response_item", timestamp: "2026-04-09T10:00:06Z", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls -la"}' } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:10Z", payload: { type: "task_complete", turn_id: "T1" } },
    ])],
    when: ["reading", ({ paneDir }) => readLastTurnsCodex(paneDir)],
    then: ["one complete turn with both items", (r, { cleanup }) => {
      expect(r.turns).toHaveLength(1);
      const t = r.turns[0];
      expect(t.userPrompt).toBe("do the thing");
      expect(t.timestamp).toBe("2026-04-09T10:00:01Z");
      expect(t.isComplete).toBe(true);
      expect(t.endTimestamp).toBe("2026-04-09T10:00:10Z");
      expect(t.items).toHaveLength(2);
      // items now carry a stable `id` (posted-set dedupe); assert type+content only.
      expect(t.items[0]).toMatchObject({ type: "text", content: "starting work" });
      expect(t.items[1].type).toBe("tool");
      expect(t.items[1].content).toContain("ls -la");
      cleanup();
    }],
  });
});

feature("readLastTurnsCodex: multi-turn limit", () => {
  unit("returns latest N turns when limit < total", {
    given: ["3-turn rollout", () => {
      const events = [
        { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      ];
      for (const id of ["A", "B", "C"]) {
        events.push(
          { type: "event_msg", payload: { type: "task_started", turn_id: id } },
          { type: "event_msg", payload: { type: "user_message", message: `prompt ${id}` } },
          { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `response ${id}` }] } },
          { type: "event_msg", payload: { type: "task_complete", turn_id: id } },
        );
      }
      return setupFakeCodex(events);
    }],
    when: ["reading with limit=2", ({ paneDir }) => readLastTurnsCodex(paneDir, { limit: 2 })],
    then: ["last 2 turns: B, C", (r, { cleanup }) => {
      expect(r.turns.map((t) => t.userPrompt)).toEqual(["prompt B", "prompt C"]);
      cleanup();
    }],
  });

  unit("tailBytes mode reads the latest turn without parsing old large history", {
    given: ["large old turn followed by a small latest turn", () => {
      const events = [
        { type: "session_meta", payload: { cwd: "/fake/workspace" } },
        { type: "event_msg", timestamp: "2026-04-09T10:00:00Z", payload: { type: "task_started", turn_id: "OLD" } },
        { type: "event_msg", timestamp: "2026-04-09T10:00:01Z", payload: { type: "user_message", message: "old prompt" } },
        { type: "response_item", timestamp: "2026-04-09T10:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(50_000) }] } },
        { type: "event_msg", timestamp: "2026-04-09T10:00:03Z", payload: { type: "task_complete", turn_id: "OLD" } },
        { type: "event_msg", timestamp: "2026-04-09T10:01:00Z", payload: { type: "task_started", turn_id: "NEW" } },
        { type: "event_msg", timestamp: "2026-04-09T10:01:01Z", payload: { type: "user_message", message: "new prompt" } },
        { type: "response_item", timestamp: "2026-04-09T10:01:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "new response" }] } },
        { type: "event_msg", timestamp: "2026-04-09T10:01:03Z", payload: { type: "task_complete", turn_id: "NEW" } },
      ];
      return setupFakeCodex(events);
    }],
    when: ["reading with a small tailBytes budget", ({ paneDir }) =>
      readLastTurnsCodex(paneDir, { limit: 1, tailBytes: 4 * 1024 })],
    then: ["latest turn is returned", (r, { cleanup }) => {
      expect(r.turns.map((t) => t.userPrompt)).toEqual(["new prompt"]);
      expect(r.turns[0].items[0].content).toBe("new response");
      cleanup();
    }],
  });

  unit("headless tail mode reconstructs a final answer after a huge tool result", {
    given: ["the bounded tail starts inside a multi-megabyte tool output after the prompt", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:00Z", payload: { type: "task_started", turn_id: "A" } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:01Z", payload: { type: "user_message", message: "render several images" } },
      { type: "response_item", timestamp: "2026-04-09T10:00:02Z", payload: { type: "custom_tool_call_output", output: "x".repeat(8_000) } },
      { type: "response_item", timestamp: "2026-04-09T10:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "summary after the images" }] } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:04Z", payload: { type: "task_complete", turn_id: "A" } },
    ])],
    when: ["reading only the last 2KB with headless recovery enabled", ({ paneDir }) =>
      readLastTurnsCodex(paneDir, { limit: 1, tailBytes: 2 * 1024, headless: true })],
    then: ["the orphaned final text is recovered as a complete synthetic turn", (r, { cleanup }) => {
      expect(r.turns).toHaveLength(1);
      expect(r.turns[0].userPrompt).toBe("");
      expect(r.turns[0].items[0].content).toBe("summary after the images");
      expect(r.turns[0].isComplete).toBe(true);
      cleanup();
    }],
  });
});

feature("readLastTurnsCodex: codex event ordering", () => {
  unit("binds task_started before user_message to the following turn", {
    given: ["two completed turns in real codex order", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:00Z", payload: { type: "task_started", turn_id: "A" } },
      { type: "turn_context", timestamp: "2026-04-09T10:00:00Z", payload: { turn_id: "A" } },
      { type: "response_item", timestamp: "2026-04-09T10:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "prompt A" }] } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:01Z", payload: { type: "user_message", message: "prompt A" } },
      { type: "response_item", timestamp: "2026-04-09T10:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "response A" }] } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:03Z", payload: { type: "task_complete", turn_id: "A" } },
      { type: "event_msg", timestamp: "2026-04-09T10:01:00Z", payload: { type: "task_started", turn_id: "B" } },
      { type: "turn_context", timestamp: "2026-04-09T10:01:00Z", payload: { turn_id: "B" } },
      { type: "response_item", timestamp: "2026-04-09T10:01:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "prompt B" }] } },
      { type: "event_msg", timestamp: "2026-04-09T10:01:01Z", payload: { type: "user_message", message: "prompt B" } },
      { type: "response_item", timestamp: "2026-04-09T10:01:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "response B" }] } },
      { type: "event_msg", timestamp: "2026-04-09T10:01:03Z", payload: { type: "task_complete", turn_id: "B" } },
    ])],
    when: ["reading", ({ paneDir }) => readLastTurnsCodex(paneDir, { limit: 2 })],
    then: ["both turns are complete with their own task_complete timestamps", (r, { cleanup }) => {
      expect(r.turns.map((t) => t.userPrompt)).toEqual(["prompt A", "prompt B"]);
      expect(r.turns.map((t) => t.turnId)).toEqual(["A", "B"]);
      expect(r.turns.map((t) => t.isComplete)).toEqual([true, true]);
      expect(r.turns.map((t) => t.endTimestamp)).toEqual([
        "2026-04-09T10:00:03Z",
        "2026-04-09T10:01:03Z",
      ]);
      cleanup();
    }],
  });

  unit("keeps the active task id across busy-injected prompts and compaction", {
    given: ["one codex task receives multiple prompts before its final answer", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:00Z", payload: { type: "task_started", turn_id: "A" } },
      { type: "turn_context", timestamp: "2026-04-09T10:00:00Z", payload: { turn_id: "A" } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:01Z", payload: { type: "user_message", message: "initial brief" } },
      { type: "response_item", timestamp: "2026-04-09T10:00:02Z", payload: { type: "function_call", name: "wait", arguments: JSON.stringify({ cell_id: 1 }) } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:03Z", payload: { type: "user_message", message: "follow-up while busy" } },
      { type: "response_item", timestamp: "2026-04-09T10:00:04Z", payload: { type: "function_call", name: "wait", arguments: JSON.stringify({ cell_id: 2 }) } },
      { type: "compacted", timestamp: "2026-04-09T10:00:05Z", payload: {} },
      { type: "turn_context", timestamp: "2026-04-09T10:00:05Z", payload: { turn_id: "A" } },
      { type: "response_item", timestamp: "2026-04-09T10:00:06Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "final answer after images" }] } },
      { type: "event_msg", timestamp: "2026-04-09T10:00:07Z", payload: { type: "task_complete", turn_id: "A" } },
    ])],
    when: ["reading both logical prompt segments", ({ paneDir }) => readLastTurnsCodex(paneDir, { limit: 2 })],
    then: ["the boundary settles the first segment and task_complete settles the latest", (r, { cleanup }) => {
      expect(r.turns.map((t) => t.turnId)).toEqual(["A", "A"]);
      expect(r.turns.map((t) => t.isComplete)).toEqual([true, true]);
      expect(r.turns[1].items.at(-1).content).toBe("final answer after images");
      expect(r.compactions).toHaveLength(1);
      expect(r.compactions[0].timestamp).toBe("2026-04-09T10:00:05Z");
      cleanup();
    }],
  });
});

feature("readLastTurnsCodex: unfinished turn", () => {
  unit("returns turn with isComplete=false when task_complete is missing", {
    given: ["rollout where last task_started has no task_complete", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "X" } },
      { type: "event_msg", payload: { type: "user_message", message: "in progress" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "still thinking..." }] } },
    ])],
    when: ["reading", ({ paneDir }) => readLastTurnsCodex(paneDir)],
    then: ["one turn marked incomplete", (r, { cleanup }) => {
      expect(r.turns).toHaveLength(1);
      expect(r.turns[0].isComplete).toBe(false);
      expect(r.turns[0].userPrompt).toBe("in progress");
      cleanup();
    }],
  });
});

feature("readLastTurnsCodex: reasoning events skipped", () => {
  unit("does not include reasoning blocks in items", {
    given: ["rollout with reasoning + assistant text", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "R" } },
      { type: "event_msg", payload: { type: "user_message", message: "think" } },
      { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "internal reasoning" }] } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "the answer" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "R" } },
    ])],
    when: ["reading", ({ paneDir }) => readLastTurnsCodex(paneDir)],
    then: ["only the assistant text appears, reasoning skipped", (r, { cleanup }) => {
      expect(r.turns[0].items).toHaveLength(1);
      expect(r.turns[0].items[0]).toMatchObject({ type: "text", content: "the answer" });
      cleanup();
    }],
  });
});

feature("readLastTurnsCodex: no matching session", () => {
  unit("returns null when paneDir has no session", {
    given: ["fake home with no codex sessions", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "agentmux-codex-empty-"));
      const origHome = process.env.HOME;
      process.env.HOME = fakeHome;
      return {
        cleanup: () => {
          process.env.HOME = origHome;
          rmSync(fakeHome, { recursive: true, force: true });
        },
      };
    }],
    when: ["reading", () => readLastTurnsCodex("/some/empty/dir")],
    then: ["returns null", (r, { cleanup }) => {
      expect(r).toBe(null);
      cleanup();
    }],
  });
});

feature("readLastTurnsCodex: tool-only turn", () => {
  unit("returns turn with only function_call items, no text", {
    given: ["rollout where assistant only calls a tool, no text", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "T" } },
      { type: "event_msg", payload: { type: "user_message", message: "run ls" } },
      { type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: '{"cmd":"ls"}' } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "T" } },
    ])],
    when: ["reading", ({ paneDir }) => readLastTurnsCodex(paneDir)],
    then: ["turn has one tool item, no text items", (r, { cleanup }) => {
      expect(r.turns[0].items).toHaveLength(1);
      expect(r.turns[0].items[0].type).toBe("tool");
      cleanup();
    }],
  });
});

feature("latestCodexJsonlMtime", () => {
  unit("returns mtime of the matched session in epoch ms", {
    given: ["a single rollout", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
    ])],
    when: ["reading mtime", ({ paneDir }) => latestCodexJsonlMtime(paneDir)],
    then: ["positive number", (r, { cleanup }) => {
      expect(typeof r).toBe("number");
      expect(r).toBeGreaterThan(0);
      cleanup();
    }],
  });

  unit("returns null when no session matches", {
    given: ["empty fake home", () => {
      const fakeHome = mkdtempSync(join(tmpdir(), "agentmux-codex-mtime-"));
      const origHome = process.env.HOME;
      process.env.HOME = fakeHome;
      return {
        cleanup: () => {
          process.env.HOME = origHome;
          rmSync(fakeHome, { recursive: true, force: true });
        },
      };
    }],
    when: ["reading mtime", () => latestCodexJsonlMtime("/some/empty/dir")],
    then: ["null", (r, { cleanup }) => {
      expect(r).toBe(null);
      cleanup();
    }],
  });
});

feature("latestCodexSessionFor", () => {
  unit("exposes the same matching as the internal lookup", {
    given: ["a single rollout in fake home", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
    ])],
    when: ["looking up", ({ paneDir }) => latestCodexSessionFor(paneDir)],
    then: ["returns a path containing rollout-", (r, { cleanup }) => {
      expect(r).toMatch(/rollout-/);
      cleanup();
    }],
  });
});

// --- Race regression: task_complete before response_item ----------------

feature("readLastTurnsCodex: task_complete-before-response_item race", () => {
  unit("does NOT mark turn complete when task_complete arrives before items", {
    given: ["jsonl with task_complete written but response_item not yet", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "R" } },
      { type: "event_msg", payload: { type: "user_message", message: "ask something" } },
      // Codex flush race: task_complete written first, response_item:message
      // would normally come right before but lands later. This is the empty
      // window where the watcher would otherwise read isComplete=true with
      // items=0 and silently advance its checkpoint.
      { type: "event_msg", payload: { type: "task_complete", turn_id: "R" } },
    ])],
    when: ["reading mid-race", ({ paneDir }) => readLastTurnsCodex(paneDir)],
    then: ["isComplete stays false because items=0", (r, { cleanup }) => {
      expect(r.turns).toHaveLength(1);
      expect(r.turns[0].isComplete).toBe(false);
      expect(r.turns[0].items).toHaveLength(0);
      cleanup();
    }],
  });

  unit("DOES mark turn complete once response_item lands after task_complete", {
    given: ["same race resolved with response_item appended", () => setupFakeCodex([
      { type: "session_meta", payload: { cwd: "/fake/workspace" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "R" } },
      { type: "event_msg", payload: { type: "user_message", message: "ask something" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "R" } },
      // The delayed flush eventually catches up
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "delayed reply" }] } },
    ])],
    when: ["reading after race resolved", ({ paneDir }) => readLastTurnsCodex(paneDir)],
    then: ["isComplete=true with the delayed item", (r, { cleanup }) => {
      expect(r.turns[0].isComplete).toBe(true);
      expect(r.turns[0].items).toMatchObject([{ type: "text", content: "delayed reply" }]);
      cleanup();
    }],
  });
});
