import { feature, unit, expect } from "bdd-vitest";
import {
  CLAUDE, CODEX, ALL_DIALECTS, detectDialect,
  matchesAnyBullet, matchesAnyToolResult, matchesAnyToolCall,
  matchesAnyPromptPrefix, matchesAnyPromptWithText, stripBullet,
} from "./dialects.mjs";

// --- Data integrity ------------------------------------------------------

feature("dialect data integrity", () => {
  unit("every dialect has the required fields", {
    given: ["ALL_DIALECTS", () => ALL_DIALECTS],
    when: ["checking each", (dialects) => dialects.map((d) => ({
      name: d.name,
      hasPromptChar: typeof d.promptChar === "string" && d.promptChar.length === 1,
      hasBullet: typeof d.bullet === "string" && d.bullet.length === 1,
      hasToolResultPrefix: typeof d.toolResultPrefix === "string",
      hasToolCallPattern: d.toolCallPattern instanceof RegExp,
      hasIdleFlag: typeof d.idleWhenPromptEmpty === "boolean",
      hasNoiseArray: Array.isArray(d.noise),
      hasBusySignals: Array.isArray(d.busySignals) && d.busySignals.length > 0,
    }))],
    then: ["all fields present", (results) => {
      for (const r of results) {
        expect(r.hasPromptChar, `${r.name}: promptChar`).toBe(true);
        expect(r.hasBullet, `${r.name}: bullet`).toBe(true);
        expect(r.hasToolResultPrefix, `${r.name}: toolResultPrefix`).toBe(true);
        expect(r.hasToolCallPattern, `${r.name}: toolCallPattern`).toBe(true);
        expect(r.hasIdleFlag, `${r.name}: idleWhenPromptEmpty`).toBe(true);
        expect(r.hasNoiseArray, `${r.name}: noise`).toBe(true);
        expect(r.hasBusySignals, `${r.name}: busySignals`).toBe(true);
      }
    }],
  });

  unit("busy signals cover truncated 'esc to interrupt'", {
    given: ["all dialects", () => ALL_DIALECTS],
    when: ["checking each dialect", (ds) => ds.map((d) => ({
      name: d.name,
      covers: d.busySignals.some((s) => "esc to interrup".includes(s) || s.includes("esc to interrup")),
    }))],
    then: ["every dialect catches 'esc to interrup' (truncated)", (results) => {
      // "esc to interrup" (no trailing t) happens when tmux pane is too narrow
      // and truncates the UI. Every dialect should catch that substring.
      for (const r of results) {
        expect(r.covers, `${r.name} must cover truncated interrupt`).toBe(true);
      }
    }],
  });

  unit("dialect glyphs are unique across dialects", {
    given: ["all dialects", () => ALL_DIALECTS],
    when: ["collecting glyphs", (ds) => ({
      prompts: ds.map((d) => d.promptChar),
      bullets: ds.map((d) => d.bullet),
    })],
    then: ["no duplicates", ({ prompts, bullets }) => {
      expect(new Set(prompts).size).toBe(prompts.length);
      expect(new Set(bullets).size).toBe(bullets.length);
    }],
  });
});

// --- detectDialect -------------------------------------------------------

feature("detectDialect", () => {
  unit("detects Codex via banner", {
    given: ["raw with Codex banner", () => ">_ OpenAI Codex (v0.118.0)\n\n› hej"],
    when: ["detecting", (raw) => detectDialect(raw)],
    then: ["returns CODEX", (d) => expect(d).toBe(CODEX)],
  });

  unit("detects Codex via prompt marker", {
    given: ["raw with › in tail", () => "old stuff\n\n› Find and fix a bug\n\nanother"],
    when: ["detecting", (raw) => detectDialect(raw)],
    then: ["returns CODEX", (d) => expect(d).toBe(CODEX)],
  });

  unit("detects Claude via prompt marker", {
    given: ["raw with ❯ prompt", () => " ▐▛███▜▌   Claude Code v2.1.96\n\n❯ hej"],
    when: ["detecting", (raw) => detectDialect(raw)],
    then: ["returns CLAUDE", (d) => expect(d).toBe(CLAUDE)],
  });

  unit("defaults to CLAUDE when nothing matches", {
    given: ["raw with no markers", () => "plain text\n\nno markers here"],
    when: ["detecting", (raw) => detectDialect(raw)],
    then: ["returns CLAUDE", (d) => expect(d).toBe(CLAUDE)],
  });
});

// --- Cross-dialect helpers ----------------------------------------------

feature("matchesAnyBullet", () => {
  unit("matches Claude ●", {
    when: ["checking", () => matchesAnyBullet("● hej")],
    then: ["true", (r) => expect(r).toBe(true)],
  });
  unit("matches Codex •", {
    when: ["checking", () => matchesAnyBullet("• hej")],
    then: ["true", (r) => expect(r).toBe(true)],
  });
  unit("rejects plain text", {
    when: ["checking", () => matchesAnyBullet("hej")],
    then: ["false", (r) => expect(r).toBe(false)],
  });
});

feature("matchesAnyToolResult", () => {
  unit("matches Claude ⎿ with leading spaces", {
    when: ["checking", () => matchesAnyToolResult("  ⎿  output")],
    then: ["true", (r) => expect(r).toBe(true)],
  });
  unit("matches Claude ⎿ with non-breaking spaces", {
    when: ["checking", () => matchesAnyToolResult("\u00a0\u00a0⎿ \u00a0output")],
    then: ["true", (r) => expect(r).toBe(true)],
  });
  unit("matches Codex └", {
    when: ["checking", () => matchesAnyToolResult("  └ output")],
    then: ["true", (r) => expect(r).toBe(true)],
  });
});

feature("matchesAnyToolCall", () => {
  unit("matches Claude Bash()", {
    when: ["checking", () => matchesAnyToolCall("● Bash(ls)")],
    then: ["true", (r) => expect(r).toBe(true)],
  });
  unit("matches Codex Ran verb", {
    when: ["checking", () => matchesAnyToolCall("• Ran date")],
    then: ["true", (r) => expect(r).toBe(true)],
  });
  unit("matches Codex Explored", {
    when: ["checking", () => matchesAnyToolCall("• Explored")],
    then: ["true", (r) => expect(r).toBe(true)],
  });
  unit("rejects Codex text (• Hej!)", {
    when: ["checking", () => matchesAnyToolCall("• Hej!")],
    then: ["false", (r) => expect(r).toBe(false)],
  });
});

feature("stripBullet", () => {
  unit("strips Claude ● prefix", {
    when: ["stripping", () => stripBullet("● Hej!")],
    then: ["clean text", (r) => expect(r).toBe("Hej!")],
  });
  unit("strips Codex • prefix", {
    when: ["stripping", () => stripBullet("• Stockholm")],
    then: ["clean text", (r) => expect(r).toBe("Stockholm")],
  });
  unit("leaves plain text alone", {
    when: ["stripping", () => stripBullet("no bullet here")],
    then: ["unchanged", (r) => expect(r).toBe("no bullet here")],
  });
});

feature("Claude busy regex: present vs past tense", () => {
  // Helper: run raw through Claude's regex busy signals
  const isBusyByRegex = (raw) => CLAUDE.busySignals.some((s) =>
    typeof s === "string" ? raw.includes(s) : s.test(raw));

  unit("PRESENT '✻ Musing…' is busy", {
    when: ["checking", () => isBusyByRegex("✻ Musing… (2s · ↓ 40 tokens)")],
    then: ["busy", (r) => expect(r).toBe(true)],
  });

  unit("PRESENT '· Orchestrating…' is busy", {
    when: ["checking", () => isBusyByRegex("· Orchestrating… (9s · ↓ 129 tokens)")],
    then: ["busy", (r) => expect(r).toBe(true)],
  });

  unit("PRESENT '* Waddling…' is busy", {
    when: ["checking", () => isBusyByRegex("* Waddling… (6s · ↓ 85 tokens)")],
    then: ["busy", (r) => expect(r).toBe(true)],
  });

  unit("PRESENT '✢ Frolicking…' is busy", {
    when: ["checking", () => isBusyByRegex("✢ Frolicking… (15s · ↓ 311 tokens)")],
    then: ["busy", (r) => expect(r).toBe(true)],
  });

  unit("PAST '✻ Worked for 32s' is NOT busy (regression)", {
    when: ["checking", () => isBusyByRegex("✻ Worked for 32s")],
    then: ["idle", (r) => expect(r).toBe(false)],
  });

  unit("PAST '✻ Cogitated for 14s' is NOT busy", {
    when: ["checking", () => isBusyByRegex("✻ Cogitated for 14s · ↓ 500 tokens")],
    then: ["idle", (r) => expect(r).toBe(false)],
  });

  unit("PAST '✻ Brewed for 2s' is NOT busy", {
    when: ["checking", () => isBusyByRegex("✻ Brewed for 2s")],
    then: ["idle", (r) => expect(r).toBe(false)],
  });
});
