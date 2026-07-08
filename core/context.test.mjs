// Context reading must survive session-limit spam, and prefer pushed truth.
//
// Session-limit spam: a rate-limited pane logs assistant messages from model
// "<synthetic>" with all-zero usage. Trusting those poisoned two consumers at
// once (ai:1, 2026-07-08 18:50): zero usage → "0%" false calm, and
// "<synthetic>" as latest model → 200k default window → real 351k tokens
// clamped to a false "100%" that fired an auto-compact warning at a merely
// rate-limited pane. The guard: context truth is the newest REAL turn.
//
// Pushed truth: Claude Code renders its own percent through the statusline,
// which tees it to os.tmpdir()/claude-ctx-<session>.json. When fresh, that
// beats every scrape/jsonl reconstruction.

import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import * as fsExtra from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getContextPercent, getContextFromPane, getContextPushed, resetCodexSessionIndexForTests } from "./context.mjs";

const usageEntry = (model, total) => JSON.stringify({
  timestamp: "2026-07-08T16:49:00.000Z",
  message: {
    model,
    usage: {
      input_tokens: 4,
      cache_read_input_tokens: Math.max(0, total - 8),
      cache_creation_input_tokens: 4,
      output_tokens: 0,
    },
  },
});

// Faithful shape of a session-limit turn: model "<synthetic>", zero usage.
const syntheticEntry = () => JSON.stringify({
  timestamp: "2026-07-08T16:50:00.000Z",
  message: {
    model: "<synthetic>",
    usage: {
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    },
  },
});

// Build a fake HOME with one claude session jsonl for paneDir, restore after.
// The session id is unique per call: getContextPushed keys the REAL
// os.tmpdir() bridge file on it, so a fixed name would leak between tests.
function withSessionJsonl(lines, run, { bridge = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), "amux-ctx-"));
  const sessionId = `amux-test-${Math.random().toString(36).slice(2)}`;
  const paneDir = join(home, "work", "pane");
  const projectDir = join(home, ".claude", "projects", paneDir.replace(/[\/\.]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join("\n") + "\n");
  const bridgePath = join(tmpdir(), `claude-ctx-${sessionId}.json`);
  if (bridge) writeFileSync(bridgePath, JSON.stringify(bridge));
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return run(paneDir);
  } finally {
    process.env.HOME = prevHome;
    try { unlinkSync(bridgePath); } catch { /* no bridge written */ }
  }
}

feature("context reading under session limit", () => {
  component("synthetic entries are skipped: percent comes from the newest real turn", {
    given: ["a real fable-5 turn at 351k buried under session-limit spam", () =>
      [usageEntry("claude-fable-5", 351_000), syntheticEntry(), syntheticEntry(), syntheticEntry()]],
    when: ["reading context from the jsonl", (lines) =>
      withSessionJsonl(lines, (paneDir) => getContextPercent(paneDir, "claude"))],
    then: ["35% of the 1M window, real model — not 0%", (ctx) => {
      expect(ctx.percent).toBe(35);
      expect(ctx.model).toBe("claude-fable-5");
    }],
  });

  component("an all-synthetic tail reports null, never a fabricated percent", {
    given: ["a jsonl containing only session-limit entries", () =>
      [syntheticEntry(), syntheticEntry(), syntheticEntry()]],
    when: ["reading context from the jsonl", (lines) =>
      withSessionJsonl(lines, (paneDir) => getContextPercent(paneDir, "claude"))],
    then: ["null — honest 'no data' (auto-compact then does nothing)", (ctx) =>
      expect(ctx).toBeNull()],
  });

  component("idle-save hint + synthetic latest model no longer clamps to false 100%", {
    given: ["ai:1's exact shape: pane shows 'save 351.2k tokens', jsonl ends in synthetic spam", () => ({
      lines: [usageEntry("claude-fable-5", 351_000), syntheticEntry(), syntheticEntry()],
      pane: "  some scrollback\n  new task? /clear to save 351.2k tokens\n  ❯ \n",
    })],
    when: ["reading context from the pane content", ({ lines, pane }) =>
      withSessionJsonl(lines, (paneDir) => getContextFromPane(pane, paneDir))],
    then: ["window resolves via the real model (1M) → ~35%, not 100%", (ctx) => {
      expect(ctx.percent).toBe(35);
      expect(ctx.model).toBe("claude-fable-5");
    }],
  });
});

feature("pushed statusline truth", () => {
  const nowS = () => Math.floor(Date.now() / 1000);

  component("a fresh bridge file beats jsonl math", {
    given: ["jsonl says 35% but Claude Code's own statusline pushed 92%", () => ({
      lines: [usageEntry("claude-fable-5", 351_000)],
      bridge: { used_pct: 92, timestamp: nowS() },
    })],
    when: ["reading context", ({ lines, bridge }) =>
      withSessionJsonl(lines, (paneDir) => getContextPercent(paneDir, "claude"), { bridge })],
    then: ["92% — Claude Code's rendered number wins; tokens/model still from jsonl", (ctx) => {
      expect(ctx.percent).toBe(92);
      expect(ctx.model).toBe("claude-fable-5");
      expect(ctx.tokens).toBe(351_000);
    }],
  });

  component("a stale bridge file is distrusted — jsonl math stands", {
    given: ["a bridge file from a session 3 hours dead", () => ({
      lines: [usageEntry("claude-fable-5", 351_000)],
      bridge: { used_pct: 92, timestamp: nowS() - 3 * 3600 },
    })],
    when: ["reading context", ({ lines, bridge }) =>
      withSessionJsonl(lines, (paneDir) => getContextPercent(paneDir, "claude"), { bridge })],
    then: ["35% from jsonl", (ctx) => expect(ctx.percent).toBe(35)],
  });

  component("a garbage bridge file never poisons the reading", {
    given: ["a bridge file with an out-of-range percent", () => ({
      lines: [usageEntry("claude-fable-5", 351_000)],
      bridge: { used_pct: 166, timestamp: nowS() },
    })],
    when: ["reading pushed context directly", ({ lines, bridge }) =>
      withSessionJsonl(lines, (paneDir) => getContextPushed(paneDir), { bridge })],
    then: ["null — callers fall through to jsonl", (ctx) => expect(ctx).toBeNull()],
  });

  component("pushed truth short-circuits the pane-content parse", {
    given: ["pane shows a 100%-shaped idle-save hint but the bridge says 41%", () => ({
      lines: [usageEntry("claude-fable-5", 351_000)],
      bridge: { used_pct: 41, timestamp: nowS() },
      pane: "  new task? /clear to save 351.2k tokens\n  ❯ \n",
    })],
    when: ["reading context from pane content", ({ lines, bridge, pane }) =>
      withSessionJsonl(lines, (paneDir) => getContextFromPane(pane, paneDir), { bridge })],
    then: ["41% — the pane image is fallback, not truth", (ctx) =>
      expect(ctx.percent).toBe(41)],
  });
});

feature("golden fixtures — every context source", () => {
  component("custom statusline row: Claude Code's rendered percent is never recomputed", {
    given: ["the 2026-06-10 shape: statusline shows 92%, jsonl math would say 77%", () => ({
      lines: [usageEntry("claude-fable-5[1m]", 769_000)],
      pane: "  scrollback\n/gsd-update | claude-fable-5[1m] | ▓▓▓▓▓▓▓░░░ 92%\n",
    })],
    when: ["reading context from the pane content", ({ lines, pane }) =>
      withSessionJsonl(lines, (paneDir) => getContextFromPane(pane, paneDir))],
    then: ["92% — the on-screen number wins; tokens from jsonl for display", (ctx) => {
      expect(ctx.percent).toBe(92);
      expect(ctx.tokens).toBe(769_000);
    }],
  });

  component("codex token_count: last_token_usage over model_context_window", {
    given: ["a codex rollout for the pane's cwd", () => null],
    when: ["reading context via the codex dialect", () => {
      const { mkdtempSync, mkdirSync, writeFileSync } = fsExtra;
      const home = mkdtempSync(join(tmpdir(), "amux-codex-"));
      const paneDir = join(home, "work", "pane4");
      const day = join(home, ".codex", "sessions", "2026", "07", "08");
      mkdirSync(day, { recursive: true });
      mkdirSync(paneDir, { recursive: true });
      writeFileSync(join(day, "rollout-x.jsonl"), [
        JSON.stringify({ type: "session_meta", payload: { cwd: paneDir } }),
        JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: {
          model_context_window: 256_000,
          last_token_usage: { input_tokens: 60_000, cached_input_tokens: 50_000, output_tokens: 4_000 },
        } } }),
      ].join("\n") + "\n");
      const prevHome = process.env.HOME;
      process.env.HOME = home;
      resetCodexSessionIndexForTests();
      try {
        return getContextPercent(paneDir, "codex");
      } finally {
        process.env.HOME = prevHome;
        resetCodexSessionIndexForTests();
      }
    }],
    then: ["25% — (60k input incl. cache + 4k output) / 256k window", (ctx) => {
      expect(ctx.percent).toBe(25);
      expect(ctx.tokens).toBe(64_000);
    }],
  });
});
