import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getContextPercent, getContextFromPane } from "../core/context.mjs";

/**
 * Build a claude project jsonl with a single assistant event carrying a
 * usage block. Returns { paneDir, cleanup }.
 */
function setupFakeClaudeContext({ model, input = 0, cacheRead = 0, cacheCreate = 0, output = 0 }, paneDir = "/fake/workspace") {
  const fakeHome = mkdtempSync(join(tmpdir(), "agentmux-context-test-"));
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

  unit("opus-4-8 at 288k uses 1M max → ~29% (not 100%)", {
    // Regression: opus-4-8 was missing from the model table, so a 1M-context
    // pane at 288k tokens read 288k/200k → capped 100%, firing false
    // auto-compacts on a pane that was really ~29% full.
    given: ["288k usage on claude-opus-4-8", () => setupFakeClaudeContext({ model: "claude-opus-4-8", cacheRead: 288_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["~29% against 1M, not 100%", (r, { cleanup }) => {
      expect(r.tokens).toBe(288_000);
      expect(r.percent).toBe(29);
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

  unit("future-proof: unreleased opus/sonnet resolves to 1M via family heuristic", {
    // The durable fix: no allowlist edit needed for new dated variants. A model
    // we've never seen still gets the right window as long as it's opus/sonnet.
    given: ["hypothetical claude-opus-5-0 at 250k usage", () => setupFakeClaudeContext({ model: "claude-opus-5-0", cacheRead: 250_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["25% of 1M, not 100% against a stale 200k default", (r, { cleanup }) => {
      expect(r.percent).toBe(25);
      cleanup();
    }],
  });

  unit("family floor: haiku stays 200k (not 1M)", {
    given: ["future haiku variant at 100k usage", () => setupFakeClaudeContext({ model: "claude-haiku-5-0", cacheRead: 100_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["50% of 200k", (r, { cleanup }) => {
      expect(r.percent).toBe(50);
      cleanup();
    }],
  });

  unit("fable-5 at 174k uses 1M max → 17% (not 87%)", {
    // Regression: the jsonl records "claude-fable-5" (no [1m] suffix), which
    // matched no family → 200k default → an idle fable pane at 174k read as
    // 87% and was auto-compacted mid-task. Second occurrence of the
    // new-name-falls-to-200k class (first was opus-4-8).
    given: ["174k usage on claude-fable-5", () => setupFakeClaudeContext({ model: "claude-fable-5", cacheRead: 174_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["17% of 1M, not 87% of 200k", (r, { cleanup }) => {
      expect(r.tokens).toBe(174_000);
      expect(r.percent).toBe(17);
      cleanup();
    }],
  });

  unit("unknown NEW claude family defaults to 1M (safe direction)", {
    // The durable class-fix: a family name we've never seen must not fall to
    // 200k (over-report → false compact destroys live context). Worst case of
    // assuming 1M for a true-200k model is a late/never amux compact — Claude
    // Code's own compaction still protects the pane.
    given: ["hypothetical claude-zephyr-6 at 250k usage", () => setupFakeClaudeContext({ model: "claude-zephyr-6", cacheRead: 250_000 })],
    when: ["getting context", ({ paneDir }) => getContextPercent(paneDir, "claude")],
    then: ["25% of 1M", (r, { cleanup }) => {
      expect(r.percent).toBe(25);
      cleanup();
    }],
  });
});

feature("getContextFromPane: reads from pane content (per-pane correct)", () => {
  const WIDE_ACTIVE = [
    "   current work",
    "",
    "───────────────────────────────────────────────────────────────────────────────",
    "❯ ",
    "───────────────────────────────────────────────────────────────────────────────",
    "  ⬆ /gsd-update │ Opus 4.7 (1M context) │ 0 ████░░░░░░ 41%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    "                                                                340360 tokens",
    "                                           current: 2.1.114 · latest: 2.1.116",
  ].join("\n");

  const IDLE = [
    "                     new task? /clear to save 134.8k tokens",
    "                     new task? /clear to save 134.8k tokens",
  ].join("\n");

  const NARROW_NO_BAR = [
    "──────────────────",
    "❯ ",
    "──────────────────",
    "  ⬆ /gsd-update…",
    "  ⏵⏵ bypass",
    "   253255 tokens",
    "  new task? /cl…",
  ].join("\n");

  const THINKING_NOISE = [
    "✻ Musing… (2s · ↓ 40 tokens)",
    "  ⬆ /gsd-update │ Opus 4.7 (1M context) │ 0 ████░░░░░░ 7%",
    "                                                                 70000 tokens",
  ].join("\n");

  const STALE_PRE_COMPACT_SCROLLBACK = [
    "  ⬆ /gsd-update │ Opus 4.7 │ 5 ███████░░░ 74%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    "                                                                    0 tokens",
    "                                                 current: 2.1.147 · latest:",
    "──────────────────────────────────────────────────────────────────────────────",
    "❯ ",
    "──────────────────────────────────────────────────────────────────────────────",
    "  ⬆ /gsd-update │ Opus 4.7 │ 5 ░░░░░░░░░░ 0%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    "                                                 current: 2.1.147 · latest:",
    "❯ ",
    "──────────────────────────────────────────────────────────────────────────────",
    "  ⬆ /gsd-update │ Opus 4.7 │ 5 ░░░░░░░░░░ 0%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents",
    "                                                                    0 tokens",
  ].join("\n");

  const STALE_BAR_BEFORE_IDLE_SAVE = [
    "  ⬆ /gsd-update │ Opus 4.7 (1M context) │ 5 ███████░░░ 74%",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
    "                                                                    740000 tokens",
    "──────────────────────────────────────────────────────────────────────────────",
    "❯ ",
    "──────────────────────────────────────────────────────────────────────────────",
    "                     new task? /clear to save 12.3k tokens",
  ].join("\n");

  unit("wide active pane: reads progress bar 41% + counter 340360", {
    given: ["wide active pane content", () => WIDE_ACTIVE],
    when: ["parsing pane", (c) => getContextFromPane(c)],
    then: ["41% and 340360 tokens", (r) => {
      expect(r).not.toBeNull();
      expect(r.percent).toBe(41);
      expect(r.tokens).toBe(340_360);
    }],
  });

  unit("idle pane: parses 'save N.Nk tokens' as 134800", {
    given: ["idle pane hint", () => IDLE],
    when: ["parsing pane", (c) => getContextFromPane(c)],
    then: ["134800 tokens", (r) => {
      expect(r).not.toBeNull();
      expect(r.tokens).toBe(134_800);
    }],
  });

  unit("narrow pane without '(1M context)': falls back to 200k default → 100% capped", {
    given: ["narrow pane, 253k tokens, no progress bar, no 1M hint", () => NARROW_NO_BAR],
    when: ["parsing pane with no paneDir", (c) => getContextFromPane(c)],
    then: ["tokens correct, percent capped at 100", (r) => {
      expect(r.tokens).toBe(253_255);
      expect(r.percent).toBe(100);
    }],
  });

  unit("narrow pane with paneDir fallback: uses jsonl model → 25% of 1M", {
    given: ["narrow pane + a fake claude-opus-4-7 jsonl in cwd", () => {
      const ctx = setupFakeClaudeContext({ model: "claude-opus-4-7", cacheRead: 1 });
      return { content: NARROW_NO_BAR, paneDir: ctx.paneDir, cleanup: ctx.cleanup };
    }],
    when: ["parsing pane with paneDir", ({ content, paneDir }) => getContextFromPane(content, paneDir)],
    then: ["253255 tokens at ~25% of 1M", (r, { cleanup }) => {
      expect(r.tokens).toBe(253_255);
      expect(r.percent).toBe(25);
      cleanup();
    }],
  });

  unit("thinking-indicator tokens delta ignored: uses status bar counter not '↓ 40 tokens'", {
    given: ["active pane with thinking delta + real counter", () => THINKING_NOISE],
    when: ["parsing pane", (c) => getContextFromPane(c)],
    then: ["70000 tokens, 7% (not 40)", (r) => {
      expect(r.tokens).toBe(70_000);
      expect(r.percent).toBe(7);
    }],
  });

  unit("stale pre-compact status bar in scrollback does not override current 0%", {
    given: ["pane capture with old 74% bar above current 0% bar", () => STALE_PRE_COMPACT_SCROLLBACK],
    when: ["parsing pane", (c) => getContextFromPane(c)],
    then: ["uses newest progress bar", (r) => {
      expect(r.tokens).toBe(0);
      expect(r.percent).toBe(0);
    }],
  });

  unit("idle save hint does not inherit stale progress bar from scrollback", {
    given: ["old 74% status bar above current idle save hint", () => STALE_BAR_BEFORE_IDLE_SAVE],
    when: ["parsing pane", (c) => getContextFromPane(c)],
    then: ["computes percent from save tokens instead", (r) => {
      expect(r.tokens).toBe(12_300);
      expect(r.percent).toBe(1);
    }],
  });

  unit("empty content returns null", {
    when: ["parsing empty", () => getContextFromPane("")],
    then: ["null", (r) => { expect(r).toBeNull(); }],
  });

  unit("no tokens found returns null", {
    when: ["parsing content without tokens marker", () => getContextFromPane("just text\nno numbers here")],
    then: ["null", (r) => { expect(r).toBeNull(); }],
  });
});
