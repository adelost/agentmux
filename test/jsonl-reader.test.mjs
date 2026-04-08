import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";
import { extractFromJsonl, formatJsonlToolCall, isBusyFromJsonl } from "../core/jsonl-reader.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixtureFile = (name) => join(__dir, "fixtures/jsonl", name);

// --- Setup: fake HOME with a claude project dir ---------------------------

/**
 * Create a fake $HOME and drop a fixture jsonl into the project dir that
 * corresponds to `paneDir`. Returns the paneDir plus a cleanup function.
 */
function setupFakeProject(fixtureName, paneDir = "/fake/lsrc/.agents/1") {
  const fakeHome = mkdtempSync(join(tmpdir(), "agentus-jsonl-test-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const encoded = paneDir.replace(/[\/\.]/g, "-");
  const projectDir = join(fakeHome, ".claude", "projects", encoded);
  mkdirSync(projectDir, { recursive: true });

  const destFile = join(projectDir, "session-abc123.jsonl");
  copyFileSync(fixtureFile(fixtureName), destFile);

  return {
    paneDir,
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
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

feature("extractFromJsonl: prompt not found", () => {
  unit("falls back to the last user prompt when needle does not match", {
    given: ["simple fixture", () => setupFakeProject("simple-text.jsonl")],
    when: ["extracting with wrong prompt", ({ paneDir }) => extractFromJsonl(paneDir, "something else")],
    then: ["still returns the last assistant response", (result, { cleanup }) => {
      expect(result).not.toBeNull();
      expect(result.items[0].content).toBe("The answer is 4.");
      cleanup();
    }],
  });
});

// --- isBusyFromJsonl ----------------------------------------------------

feature("isBusyFromJsonl: streaming assistant with null stop_reason", () => {
  unit("returns true (busy) — claude still writing", {
    given: ["streaming fixture", () => setupFakeProject("busy-streaming.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "write a long story")],
    then: ["busy", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: user prompt with no assistant response yet", () => {
  unit("returns true (busy) — claude hasn't started", {
    given: ["user-only fixture", () => setupFakeProject("busy-no-assistant.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "hello")],
    then: ["busy", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: tool_use followed by tool_result, no final assistant", () => {
  unit("returns true (busy) — claude owes us an assistant message", {
    given: ["tool pending fixture", () => setupFakeProject("busy-tool-pending.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "read the file")],
    then: ["busy", (r, { cleanup }) => {
      expect(r).toBe(true);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: assistant with stop_reason end_turn", () => {
  unit("returns false (idle) — turn complete", {
    given: ["end_turn fixture", () => setupFakeProject("idle-end-turn.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "say hi")],
    then: ["idle", (r, { cleanup }) => {
      expect(r).toBe(false);
      cleanup();
    }],
  });
});

feature("isBusyFromJsonl: full tool turn that completed", () => {
  unit("returns false (idle) — tool executed and assistant wrote final", {
    given: ["complete tool turn", () => setupFakeProject("idle-after-tool.jsonl")],
    when: ["checking", ({ paneDir }) => isBusyFromJsonl(paneDir, "read and summarize")],
    then: ["idle", (r, { cleanup }) => {
      expect(r).toBe(false);
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
