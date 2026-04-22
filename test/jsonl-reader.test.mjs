import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync, utimesSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { extractFromJsonl, formatJsonlToolCall, isBusyFromJsonl, isPromptInJsonl, readLastTurns, parseSinceArg } from "../core/jsonl-reader.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixtureFile = (name) => join(__dir, "fixtures/jsonl", name);

// --- Setup: fake HOME with a claude project dir ---------------------------

/**
 * Create a fake $HOME and drop a fixture jsonl into the project dir that
 * corresponds to `paneDir`. Returns the paneDir plus a cleanup function.
 */
function setupFakeProject(fixtureName, paneDir = "/fake/lsrc/.agents/1") {
  const fakeHome = mkdtempSync(join(tmpdir(), "agentmux-jsonl-test-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const encoded = paneDir.replace(/[\/\.]/g, "-");
  const projectDir = join(fakeHome, ".claude", "projects", encoded);
  mkdirSync(projectDir, { recursive: true });

  const destFile = join(projectDir, "session-abc123.jsonl");
  copyFileSync(fixtureFile(fixtureName), destFile);

  return {
    paneDir,
    projectDir,
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

/**
 * Drop a second jsonl file into the same project dir and make it newer
 * than the original (simulating /clear or /compact mid-session).
 */
function addNewerSession(projectDir, fixtureName, name = "session-new999.jsonl") {
  const dest = join(projectDir, name);
  copyFileSync(fixtureFile(fixtureName), dest);
  // Bump mtime so the copy is strictly newer than the other file
  const now = Date.now() / 1000;
  utimesSync(dest, now, now + 10);
  return dest;
}

// --- extractFromJsonl ---------------------------------------------------

feature("extractFromJsonl: simple text response", () => {
  unit("returns the assistant text as a single item", {
    given: ["a fake project with simple-text fixture", () => setupFakeProject("simple-text.jsonl")],
    when: ["extracting for the prompt", ({ paneDir }) => extractFromJsonl(paneDir, "what is 2+2?")],
    then: ["single text item with the answer", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items).toEqual([{ type: "text", content: "The answer is 4." }]);
      cleanup();
    }],
  });
});

feature("extractFromJsonl: code fences preserved", () => {
  unit("keeps ```python ... ``` intact in the text item", {
    given: ["a project with code-fenced response", () => setupFakeProject("code-fenced.jsonl")],
    when: ["extracting", ({ paneDir }) => extractFromJsonl(paneDir, "show me python matrix code")],
    then: ["text item contains the full fenced block", (result, { cleanup }) => {
      expect(result.items).toHaveLength(1);
      const text = result.items[0].content;
      expect(text).toContain("```python");
      expect(text).toContain("import numpy as np");
      expect(text).toContain("A = np.array([[1, 2], [3, 4]])");
      expect(text).toContain("```");
      expect(text).toContain("This creates a 2x2 matrix.");
      cleanup();
    }],
  });
});

feature("extractFromJsonl: tool_use blocks", () => {
  unit("extracts text and tool calls in order, skips tool_result user events", {
    given: ["a project with a Read tool call", () => setupFakeProject("with-tools.jsonl")],
    when: ["extracting", ({ paneDir }) => extractFromJsonl(paneDir, "read the readme and summarize")],
    then: ["text before + tool + text after", (result, { cleanup }) => {
      expect(result.items).toHaveLength(3);
      expect(result.items[0]).toEqual({ type: "text", content: "Let me read it." });
      expect(result.items[1].type).toBe("tool");
      expect(result.items[1].content).toContain("Read");
      expect(result.items[1].content).toContain("README.md");
      expect(result.items[2]).toEqual({ type: "text", content: "It's a project that does stuff." });
      cleanup();
    }],
  });
});

feature("extractFromJsonl: multi-turn history", () => {
  unit("returns only the turn matching the prompt, not an earlier one", {
    given: ["a project with two turns", () => setupFakeProject("multi-turn.jsonl")],
    when: ["extracting the second turn", ({ paneDir }) => extractFromJsonl(paneDir, "what time is it?")],
    then: ["returns only the second response", (result, { cleanup }) => {
      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toBe("I don't know the time.");
      expect(result.items[0].content).not.toContain("Hi there");
      cleanup();
    }],
  });

  unit("returns the first turn when matching on its prompt", {
    given: ["same multi-turn fixture", () => setupFakeProject("multi-turn.jsonl")],
    when: ["extracting the first turn", ({ paneDir }) => extractFromJsonl(paneDir, "hello")],
    then: ["returns the first response", (result, { cleanup }) => {
      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toBe("Hi there.");
      cleanup();
    }],
  });
});

feature("extractFromJsonl: thinking blocks are skipped", () => {
  unit("skips { type: thinking } content, keeps text", {
    given: ["fixture with thinking block before text", () => setupFakeProject("thinking-block.jsonl")],
    when: ["extracting", ({ paneDir }) => extractFromJsonl(paneDir, "think about cats")],
    then: ["only the text remains", (result, { cleanup }) => {
      expect(result.items).toHaveLength(1);
      expect(result.items[0].content).toBe("Cats are curious.");
      expect(result.items[0].content).not.toContain("Cats are interesting");
      cleanup();
    }],
  });
});

feature("extractFromJsonl: missing project dir", () => {
  unit("returns null when no jsonl exists for the pane", {
    given: ["a nonexistent pane dir", () => ({ paneDir: "/does/not/exist/.agents/99", cleanup: () => {} })],
    when: ["extracting", ({ paneDir }) => extractFromJsonl(paneDir, "anything")],
    then: ["returns null so caller can fall back", (result, { cleanup }) => {
      expect(result).toBeNull();
      cleanup();
    }],
  });
});

feature("extractFromJsonl: prompt not found (strict matching)", () => {
  unit("returns null when a specific prompt is given but no match exists", {
    given: ["simple fixture", () => setupFakeProject("simple-text.jsonl")],
    when: ["extracting with wrong prompt", ({ paneDir }) => extractFromJsonl(paneDir, "something else")],
    then: ["null, do not fall back to last turn (could be another agent's)", (result, { cleanup }) => {
      expect(result).toBeNull();
      cleanup();
    }],
  });

  unit("returns the latest turn when no prompt is given (null needle)", {
    given: ["simple fixture", () => setupFakeProject("simple-text.jsonl")],
    when: ["extracting with no prompt", ({ paneDir }) => extractFromJsonl(paneDir, null)],
    then: ["returns the last assistant response", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items[0].content).toBe("The answer is 4.");
      cleanup();
    }],
  });
});

feature("extractFromJsonl: session rotation (/clear or /compact mid-turn)", () => {
  unit("finds a prompt in the older jsonl even when a newer empty session exists", {
    given: ["old file has the prompt, newer file has a different turn", () => {
      const ctx = setupFakeProject("simple-text.jsonl"); // "what is 2+2?" → "The answer is 4."
      // Simulate /clear: a fresh jsonl appears and becomes the newest file.
      // Our prompt is still in the original file, not the new one.
      addNewerSession(ctx.projectDir, "multi-turn.jsonl");
      return ctx;
    }],
    when: ["extracting the original prompt", ({ paneDir }) => extractFromJsonl(paneDir, "what is 2+2?")],
    then: ["still finds the turn in the older file", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items).toEqual([{ type: "text", content: "The answer is 4." }]);
      cleanup();
    }],
  });

  unit("isBusy also looks in older files when current prompt is in one of them", {
    given: ["older file is mid-turn (streaming), newer file has a different idle turn", () => {
      const ctx = setupFakeProject("busy-streaming.jsonl"); // "write a long story" still streaming
      addNewerSession(ctx.projectDir, "simple-text.jsonl");
      return ctx;
    }],
    when: ["checking busy for the older prompt", ({ paneDir }) => isBusyFromJsonl(paneDir, "write a long story")],
    then: ["reports busy, old session still streaming", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

// --- isBusyFromJsonl ----------------------------------------------------

feature("isBusyFromJsonl: streaming assistant with null stop_reason", () => {
  unit("returns true (busy), claude still writing", {
    given: ["streaming fixture", () => setupFakeProject("busy-streaming.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "write a long story")],
    then: ["busy", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: user prompt with no assistant response yet", () => {
  unit("returns true (busy), claude hasn't started", {
    given: ["user-only fixture", () => setupFakeProject("busy-no-assistant.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "hello")],
    then: ["busy", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: tool_use followed by tool_result, no final assistant", () => {
  unit("returns true (busy), claude owes us an assistant message", {
    given: ["tool pending fixture", () => setupFakeProject("busy-tool-pending.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "read the file")],
    then: ["busy", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: assistant with stop_reason end_turn", () => {
  unit("returns false (idle), turn complete", {
    given: ["end_turn fixture", () => setupFakeProject("idle-end-turn.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "say hi")],
    then: ["idle", (r, { cleanup }) => {
      expect(r).toBe(false);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: full tool turn that completed", () => {
  unit("returns false (idle), tool executed and assistant wrote final", {
    given: ["complete tool turn", () => setupFakeProject("idle-after-tool.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "read and summarize")],
    then: ["idle", (r, { cleanup }) => {
      expect(r).toBe(false);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: max_tokens is not terminal", () => {
  unit("returns busy when latest stop is max_tokens (claude will continue)", {
    given: ["max_tokens fixture with follow-up", () => setupFakeProject("max-tokens-continuation.jsonl")],
    when: ["checking busy for the prompt", ({ paneDir }) => isBusyFromJsonl(paneDir, "write a lot")],
    then: ["not busy, end_turn came after max_tokens", (r, { cleanup }) => {
      // This fixture has max_tokens FOLLOWED BY end_turn in the same turn.
      // isBusy should see the final end_turn and return false.
      expect(r).toBe(false);
      cleanup();
    }],
  });
});

feature("extractFromJsonl: max_tokens + continuation merges both texts", () => {
  unit("captures both the max_tokens message and the end_turn continuation", {
    given: ["max_tokens fixture", () => setupFakeProject("max-tokens-continuation.jsonl")],
    when: ["extracting", ({ paneDir }) => extractFromJsonl(paneDir, "write a lot")],
    then: ["merged text contains both parts", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      const text = result.items.map((i) => i.content).join(" ");
      expect(text).toContain("Part one");
      expect(text).toContain("Part two");
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: queued prompt (claude busy on prior turn)", () => {
  unit("returns true when the prompt exists only as queue-operation", {
    given: ["queued-prompt fixture", () => setupFakeProject("queued-prompt.jsonl")],
    when: ["checking busy for queued prompt", ({ paneDir }) => isBusyFromJsonl(paneDir, "queued second prompt")],
    then: ["busy, claude will pick it up after current turn", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

feature("isPromptInJsonl: matches queue-operation and attachment events", () => {
  unit("finds prompt in queue-operation event", {
    given: ["queued fixture", () => setupFakeProject("queued-prompt.jsonl")],
    when: ["checking", ({ paneDir }) => isPromptInJsonl(paneDir, "queued second prompt")],
    then: ["found", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });

  unit("still finds prompt in plain type:user event", {
    given: ["simple fixture", () => setupFakeProject("simple-text.jsonl")],
    when: ["checking", ({ paneDir }) => isPromptInJsonl(paneDir, "what is 2+2?")],
    then: ["found", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });

  unit("returns false when prompt is nowhere in jsonl", {
    given: ["simple fixture", () => setupFakeProject("simple-text.jsonl")],
    when: ["checking wrong prompt", ({ paneDir }) => isPromptInJsonl(paneDir, "not in there")],
    then: ["not found", (r, { cleanup }) => {
      expect(r).toBe(false);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: compacted session with null stop_reason", () => {
  unit("returns idle when a later user prompt proves the turn finished", {
    given: ["compacted fixture: stop=null but next user prompt exists", () =>
      setupFakeProject("compacted-no-stop-reason.jsonl")],
    when: ["checking busy for the first prompt", ({ paneDir }) =>
      isBusyFromJsonl(paneDir, "find the typos")],
    then: ["idle, next turn proves this one completed", (r, { cleanup }) => {
      expect(r).toBe(false);
      cleanup();
    }],
  });

  unit("extract still works despite null stop_reason", {
    given: ["same compacted fixture", () =>
      setupFakeProject("compacted-no-stop-reason.jsonl")],
    when: ["extracting", ({ paneDir }) =>
      extractFromJsonl(paneDir, "find the typos")],
    then: ["returns the assistant text from the null-stop turn", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items[0].content).toBe("Two typos found.");
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: stale file with null stop_reason (last turn, no next prompt)", () => {
  unit("returns idle when the file is stale (>15s) and assistant has text", {
    given: ["stale-null-stop fixture with old mtime", () => {
      const ctx = setupFakeProject("stale-null-stop.jsonl");
      // Backdate the file to 30s ago so the staleness check triggers
      const jsonlPath = join(ctx.projectDir, "session-abc123.jsonl");
      const past = (Date.now() / 1000) - 30;
      utimesSync(jsonlPath, past, past);
      return ctx;
    }],
    when: ["checking busy", ({ paneDir }) => isBusyFromJsonl(paneDir, "review this CV")],
    then: ["idle, stale file + text content = compaction artifact", (r, { cleanup }) => {
      expect(r).toBe(false);
      cleanup();
    }],
  });

  unit("returns busy when the file is fresh (<15s), could still be streaming", {
    given: ["same fixture but with current mtime", () => {
      const ctx = setupFakeProject("stale-null-stop.jsonl");
      // Touch the file to make it fresh (default mtime is now, so no-op needed)
      return ctx;
    }],
    when: ["checking busy", ({ paneDir }) => isBusyFromJsonl(paneDir, "review this CV")],
    then: ["busy, file is fresh, null stop_reason could mean active streaming", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: missing jsonl file", () => {
  unit("returns null so caller can fall back", {
    given: ["nonexistent pane", () => ({ paneDir: "/nope/.agents/99", cleanup: () => {} })],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "anything")],
    then: ["null", (r, { cleanup }) => {
      expect(r).toBeNull();
      cleanup();
    }],
  });
});

// --- formatJsonlToolCall ------------------------------------------------

feature("formatJsonlToolCall", () => {
  unit("Bash: short command", {
    when: ["formatting", () => formatJsonlToolCall({ name: "Bash", input: { command: "ls -la" } })],
    then: ["Bash + command", (r) => expect(r).toBe("Bash ls -la")],
  });

  unit("Bash: long command is truncated", {
    when: ["formatting", () => formatJsonlToolCall({ name: "Bash", input: { command: "x".repeat(200) } })],
    then: ["truncated with ellipsis", (r) => {
      expect(r.length).toBeLessThanOrEqual(90);
      expect(r).toContain("...");
    }],
  });

  unit("Read: short file path", {
    when: ["formatting", () => formatJsonlToolCall({ name: "Read", input: { file_path: "/app/main.js" } })],
    then: ["Read + path", (r) => expect(r).toBe("Read /app/main.js")],
  });

  unit("Read: deep path is shortened", {
    when: ["formatting", () => formatJsonlToolCall({ name: "Read", input: { file_path: "/home/a/b/c/d/e/f.ts" } })],
    then: ["shortened with .../", (r) => {
      expect(r).toContain("...");
      expect(r).toContain("e/f.ts");
    }],
  });

  unit("Glob: pattern shown", {
    when: ["formatting", () => formatJsonlToolCall({ name: "Glob", input: { pattern: "**/*.ts" } })],
    then: ["Glob + pattern", (r) => expect(r).toBe("Glob **/*.ts")],
  });

  unit("Task: subagent type", {
    when: ["formatting", () => formatJsonlToolCall({ name: "Task", input: { subagent_type: "Explore" } })],
    then: ["Task + type", (r) => expect(r).toBe("Task Explore")],
  });

  unit("unknown tool: generic fallback with args", {
    when: ["formatting", () => formatJsonlToolCall({ name: "Custom", input: { foo: "bar", baz: 42 } })],
    then: ["shows tool name and first args", (r) => {
      expect(r).toContain("Custom");
      expect(r).toContain("foo=bar");
    }],
  });
});

// --- readLastTurns (multi-turn history reader) ----------------------------

feature("readLastTurns: groups events into turns", () => {
  unit("multi-turn fixture yields both turns with user prompt + assistant text", {
    given: ["multi-turn fixture", () => setupFakeProject("multi-turn.jsonl")],
    when: ["reading", ({ paneDir }) => readLastTurns(paneDir, { limit: 10 })],
    then: ["2 turns in chronological order", (r, { cleanup }) => {
      expect(r).not.toBeNull();
      expect(r.turns.length).toBe(2);
      expect(r.turns[0].userPrompt).toBe("hello");
      expect(r.turns[0].items).toEqual([{ type: "text", content: "Hi there." }]);
      expect(r.turns[1].userPrompt).toBe("what time is it?");
      expect(r.turns[1].items).toEqual([{ type: "text", content: "I don't know the time." }]);
      expect(r.turns[0].timestamp).toBe("2026-04-08T20:00:00Z");
      cleanup();
    }],
  });

  unit("limit: only last N turns kept", {
    given: ["multi-turn fixture", () => setupFakeProject("multi-turn.jsonl")],
    when: ["reading with limit=1", ({ paneDir }) => readLastTurns(paneDir, { limit: 1 })],
    then: ["only the most recent turn returned", (r, { cleanup }) => {
      expect(r.turns.length).toBe(1);
      expect(r.turns[0].userPrompt).toBe("what time is it?");
      cleanup();
    }],
  });

  unit("since filter: drops turns before threshold", {
    given: ["multi-turn fixture", () => setupFakeProject("multi-turn.jsonl")],
    when: ["reading with since=20:00:02Z", ({ paneDir }) =>
      readLastTurns(paneDir, { limit: 10, since: new Date("2026-04-08T20:00:02Z") })],
    then: ["only turn >= threshold", (r, { cleanup }) => {
      expect(r.turns.length).toBe(1);
      expect(r.turns[0].userPrompt).toBe("what time is it?");
      cleanup();
    }],
  });

  unit("grep filter: keeps only turns where pattern matches prompt or content", {
    given: ["multi-turn fixture", () => setupFakeProject("multi-turn.jsonl")],
    when: ["grepping /time/i", ({ paneDir }) =>
      readLastTurns(paneDir, { limit: 10, grep: /time/i })],
    then: ["only turn containing 'time'", (r, { cleanup }) => {
      expect(r.turns.length).toBe(1);
      expect(r.turns[0].userPrompt).toBe("what time is it?");
      cleanup();
    }],
  });

  unit("tools captured as turn items", {
    given: ["with-tools fixture", () => setupFakeProject("with-tools.jsonl")],
    when: ["reading", ({ paneDir }) => readLastTurns(paneDir, { limit: 10 })],
    then: ["turn has text + tool items", (r, { cleanup }) => {
      expect(r).not.toBeNull();
      expect(r.turns.length).toBeGreaterThanOrEqual(1);
      const hasToolItem = r.turns.some((t) => t.items.some((i) => i.type === "tool"));
      expect(hasToolItem).toBe(true);
      cleanup();
    }],
  });

  unit("no jsonl: returns null (caller falls back)", {
    when: ["reading a paneDir with no project store", () => readLastTurns("/definitely/not/a/real/dir")],
    then: ["null", (r) => expect(r).toBeNull()],
  });
});

feature("parseSinceArg: ISO and relative forms", () => {
  unit("ISO timestamp parses", {
    when: ["parsing ISO", () => parseSinceArg("2026-04-22T10:00:00Z")],
    then: ["returns a Date equal to 2026-04-22T10:00:00Z", (r) => {
      expect(r).toBeInstanceOf(Date);
      expect(r.toISOString()).toBe("2026-04-22T10:00:00.000Z");
    }],
  });

  unit("relative '30min' gives a Date 30 min ago", {
    when: ["parsing 30min", () => parseSinceArg("30min")],
    then: ["close to now - 30min", (r) => {
      expect(r).toBeInstanceOf(Date);
      const diffMs = Date.now() - r.getTime();
      expect(diffMs).toBeGreaterThan(29 * 60_000);
      expect(diffMs).toBeLessThan(31 * 60_000);
    }],
  });

  unit("relative '2h' works", {
    when: ["parsing 2h", () => parseSinceArg("2h")],
    then: ["2 hours ago", (r) => {
      const diffMs = Date.now() - r.getTime();
      expect(diffMs).toBeGreaterThan(119 * 60_000);
      expect(diffMs).toBeLessThan(121 * 60_000);
    }],
  });

  unit("invalid string returns null", {
    when: ["parsing garbage", () => parseSinceArg("not-a-time")],
    then: ["null", (r) => expect(r).toBeNull()],
  });

  unit("empty string returns null", {
    when: ["parsing empty", () => parseSinceArg("")],
    then: ["null", (r) => expect(r).toBeNull()],
  });
});
