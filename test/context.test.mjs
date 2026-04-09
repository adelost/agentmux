import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getContextPercent } from "../core/context.mjs";

/**
 * Build a claude project jsonl with a single assistant event carrying a
 * usage block. Returns { paneDir, cleanup }.
 */
function setupFakeClaudeContext({ model, input = 0, cacheRead = 0, cacheCreate = 0, output = 0 }, paneDir = "/fake/workspace") {
  const fakeHome = mkdtempSync(join(tmpdir(), "agentus-context-test-"));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;

  const encoded = paneDir.replace(/[\/\.]/g, "-");
  const projectDir = join(fakeHome, ".claude", "projects", encoded);
  mkdirSync(projectDir, { recursive: true });

  const event = {
    type: "assistant",
    message: {
      role: "assistant",
      model,
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        output_tokens: output,
      },
    },
  };
  writeFileSync(join(projectDir, "session.jsonl"), JSON.stringify(event) + "\n");

  return {
    paneDir,
    cleanup: () => {
      process.env.HOME = origHome;
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

feature("getContextPercent (claude): model-based max lookup", () => {
  unit("opus-4-6 at ~200k uses 1M max → ~20%", {
    given: ["assistant usage: 200k cache_read on claude-opus-4-6", () => setupFakeClaudeContext({ model: "claude-opus-4-6", cacheRead: 200_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["~20% against 1M", (r, { cleanup }) => {
      expect(r).not.toBeNull();
      expect(r.tokens).toBe(200_000);
      expect(r.percent).toBe(20);
      cleanup();
    }],
  });

  unit("sonnet-4-6 at 500k is 50% (1M max)", {
    given: ["500k usage on sonnet-4-6", () => setupFakeClaudeContext({ model: "claude-sonnet-4-6", cacheRead: 500_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["50%", (r, { cleanup }) => {
      expect(r.percent).toBe(50);
      cleanup();
    }],
  });

  unit("unknown model at 100k is 50% (default 200k max)", {
    given: ["100k usage on claude-haiku-4-5", () => setupFakeClaudeContext({ model: "claude-haiku-4-5", cacheRead: 100_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["50%", (r, { cleanup }) => {
      expect(r.percent).toBe(50);
      cleanup();
    }],
  });

  unit("no model field at all falls back to 200k default", {
    given: ["usage with undefined model", () => setupFakeClaudeContext({ model: undefined, input: 50_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["25% of 200k", (r, { cleanup }) => {
      expect(r.percent).toBe(25);
      cleanup();
    }],
  });

  unit("self-correcting: observed > declared max bumps the ceiling", {
    given: ["sonnet at 1.2M tokens (above declared 1M)", () => setupFakeClaudeContext({ model: "claude-sonnet-4-6", cacheRead: 1_200_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["reports 100% rather than 120%", (r, { cleanup }) => {
      expect(r.tokens).toBe(1_200_000);
      expect(r.percent).toBe(100);
      cleanup();
    }],
  });

  unit("prefix match for dated variants (claude-opus-4-6-20260501)", {
    given: ["dated opus variant with 100k usage", () => setupFakeClaudeContext({ model: "claude-opus-4-6-20260501", cacheRead: 100_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["10% of 1M (recognized as opus-4-6 family)", (r, { cleanup }) => {
      expect(r.percent).toBe(10);
      cleanup();
    }],
  });
});
