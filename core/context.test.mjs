// Context reading must survive session-limit spam. When a pane is
// rate-limited, Claude Code logs assistant messages from model "<synthetic>"
// with all-zero usage. Trusting those poisoned two consumers at once
// (ai:1, 2026-07-08 18:50): zero usage → "0%" false calm, and "<synthetic>"
// as latest model → 200k default window → real 351k tokens clamped to a
// false "100%" that fired an auto-compact warning at a merely rate-limited
// pane. These tests pin the guard: context truth is the newest REAL turn.

import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getContextPercent, getContextFromPane } from "./context.mjs";

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
function withSessionJsonl(lines, run) {
  const home = mkdtempSync(join(tmpdir(), "amux-ctx-"));
  const paneDir = join(home, "work", "pane");
  const projectDir = join(home, ".claude", "projects", paneDir.replace(/[\/\.]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "session.jsonl"), lines.join("\n") + "\n");
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return run(paneDir);
  } finally {
    process.env.HOME = prevHome;
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
