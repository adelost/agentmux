import { unit, component, feature, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultSessionRoots, pruneOldSessions, formatJanitorResult } from "./janitor.mjs";

const DAY = 24 * 3600 * 1000;

// Build a roots dir with jsonl files at given ages (days). Returns { root, nowMs, paths }.
function makeRoot(specs) {
  const root = mkdtempSync(join(tmpdir(), "amux-janitor-"));
  const nowMs = Date.parse("2026-05-30T00:00:00Z");
  const paths = {};
  for (const [name, ageDays, content] of specs) {
    const p = join(root, name);
    writeFileSync(p, content ?? `${name}\n`.repeat(50));
    const t = new Date(nowMs - ageDays * DAY);
    utimesSync(p, t, t);
    paths[name] = p;
  }
  return { root, nowMs, paths };
}

feature("pruneOldSessions", () => {
  unit("covers Claude, Codex, and Kimi session roots", {
    given: ["an isolated home", () => "/tmp/amux-home"],
    when: ["resolving defaults", (home) => defaultSessionRoots(home)],
    then: ["all three provider journals are included", (roots) => {
      expect(roots).toEqual([
        "/tmp/amux-home/.claude/projects",
        "/tmp/amux-home/.codex/sessions",
        "/tmp/amux-home/.kimi-code/sessions",
      ]);
    }],
  });

  unit("keeps everything when all files are fresh", {
    given: ["two recent files (1d, 5d)", () => makeRoot([["a.jsonl", 1], ["b.jsonl", 5]])],
    when: ["pruning with 14d retention", ({ root, nowMs }) =>
      pruneOldSessions({ roots: [root], retentionDays: 14, nowMs })],
    then: ["nothing deleted, both intact", (r, { root }) => {
      rmSync(root, { recursive: true, force: true });
      expect(r.scanned).toBe(2);
      expect(r.candidates).toBe(0);
      expect(r.deleted).toBe(0);
    }],
  });

  component("deletes only files older than retention, keeps fresh (live) ones", {
    given: ["one old (20d) + one fresh (2d)", () => makeRoot([["old.jsonl", 20], ["live.jsonl", 2]])],
    when: ["pruning with 14d retention", ({ root, nowMs }) =>
      pruneOldSessions({ roots: [root], retentionDays: 14, nowMs })],
    then: ["old gone, live kept, bytes freed, manifest written", (r, { root, paths }) => {
      try {
        expect(r.candidates).toBe(1);
        expect(r.deleted).toBe(1);
        expect(existsSync(paths["old.jsonl"])).toBe(false);
        expect(existsSync(paths["live.jsonl"])).toBe(true); // live file never touched
        expect(r.freedBytes).toBeGreaterThan(0);
        const manifest = readFileSync(join(root, ".janitor-deleted.log"), "utf-8");
        expect(manifest).toContain("old.jsonl");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("dry run reports candidates but deletes nothing", {
    given: ["one old file (30d)", () => makeRoot([["old.jsonl", 30]])],
    when: ["dry pruning", ({ root, nowMs }) =>
      pruneOldSessions({ roots: [root], retentionDays: 14, nowMs, dryRun: true })],
    then: ["counted, file still present", (r, { root, paths }) => {
      try {
        expect(r.candidates).toBe(1);
        expect(r.deleted).toBe(0);
        expect(existsSync(paths["old.jsonl"])).toBe(true);
        expect(r.freedBytes).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("ignores non-jsonl files", {
    given: ["an old .md and an old .jsonl.bak", () => makeRoot([
      ["notes.md", 40], ["x.jsonl.bak", 40],
    ])],
    when: ["pruning", ({ root, nowMs }) =>
      pruneOldSessions({ roots: [root], retentionDays: 14, nowMs })],
    then: ["nothing matched", (r, { root }) => {
      rmSync(root, { recursive: true, force: true });
      expect(r.scanned).toBe(0);
      expect(r.deleted).toBe(0);
    }],
  });

  unit("recurses nested session dirs (codex YYYY/MM/DD layout)", {
    given: ["a nested old rollout", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-janitor-nest-"));
      const nowMs = Date.parse("2026-05-30T00:00:00Z");
      const deep = join(root, "2026", "01", "15");
      mkdirSync(deep, { recursive: true });
      const p = join(deep, "rollout.jsonl");
      writeFileSync(p, "x\n".repeat(100));
      const t = new Date(nowMs - 60 * DAY);
      utimesSync(p, t, t);
      return { root, nowMs };
    }],
    when: ["pruning", ({ root, nowMs }) =>
      pruneOldSessions({ roots: [root], retentionDays: 14, nowMs })],
    then: ["nested file found + deleted", (r, { root }) => {
      rmSync(root, { recursive: true, force: true });
      expect(r.candidates).toBe(1);
      expect(r.deleted).toBe(1);
    }],
  });

  unit("reports a recent oversized journal without changing it", {
    given: ["one recent journal over a small test threshold", () => makeRoot([
      ["large.jsonl", 1, "important resumable state\n".repeat(20)],
    ])],
    when: ["scanning it", ({ root, nowMs }) => ({
      root,
      result: pruneOldSessions({
        roots: [root], nowMs, oversizedThresholdBytes: 100,
      }),
    })],
    then: ["it is reported and remains byte-for-byte present", ({ root, result }) => {
      try {
        expect(result.oversized).toBe(1);
        expect(result.oversizedBytes).toBeGreaterThan(100);
        expect(result.oversizedFiles).toEqual([join(root, "large.jsonl")]);
        expect(readFileSync(join(root, "large.jsonl"), "utf8")).toContain("resumable state");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });
});

feature("formatJanitorResult", () => {
  unit("nothing-to-do message", {
    given: ["a clean result", () => ({ scanned: 5, candidates: 0, deleted: 0, failed: 0, freedBytes: 0, retentionDays: 14, dryRun: false })],
    when: ["formatting", (r) => formatJanitorResult(r)],
    then: ["mentions retention + scan count", (s) => {
      expect(s).toContain("14d");
      expect(s).toContain("5 files scanned");
    }],
  });

  unit("deleted summary reports MB + counts", {
    given: ["a delete result", () => ({ scanned: 10, candidates: 4, deleted: 4, failed: 0, freedBytes: 5 * 1024 * 1024, retentionDays: 14, dryRun: false })],
    when: ["formatting", (r) => formatJanitorResult(r)],
    then: ["shows deleted count + MB", (s) => {
      expect(s).toContain("deleted 4/4");
      expect(s).toContain("5.0MB");
    }],
  });

  unit("oversized summary separates age deletion from physical trim", {
    given: ["an oversized-only result", () => ({
      scanned: 1, candidates: 0, deleted: 0, failed: 0, freedBytes: 0,
      retentionDays: 14, dryRun: false, oversized: 1, oversizedBytes: 70 * 1024 * 1024,
    })],
    when: ["formatting", (r) => formatJanitorResult(r)],
    then: ["the safety outcome is explicit", (s) => {
      expect(s).toContain("1 recent oversized");
      expect(s).toContain("not age-deleted");
    }],
  });
});
