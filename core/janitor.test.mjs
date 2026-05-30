import { unit, component, feature, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync, readFileSync, mkdirSync } from "fs";
import { gunzipSync } from "zlib";
import { tmpdir } from "os";
import { join } from "path";
import { archiveOldSessions, formatJanitorResult } from "./janitor.mjs";

const DAY = 24 * 3600 * 1000;

// Build a roots dir with jsonl files at given ages (days). Returns { root, paths }.
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

feature("archiveOldSessions", () => {
  unit("no candidates when everything is fresh", {
    given: ["two recent jsonl files", () => makeRoot([
      ["a.jsonl", 1], ["b.jsonl", 5],
    ])],
    when: ["scanning with 30d retention", ({ root, nowMs }) =>
      archiveOldSessions({ roots: [root], retentionDays: 30, nowMs })],
    then: ["nothing archived, both files intact", (r, { root }) => {
      rmSync(root, { recursive: true, force: true });
      expect(r.scanned).toBe(2);
      expect(r.candidates).toBe(0);
      expect(r.archived).toBe(0);
    }],
  });

  component("gzips only files older than retention, leaves fresh ones", {
    given: ["one old (40d) + one fresh (2d) file", () => makeRoot([
      ["old.jsonl", 40], ["fresh.jsonl", 2],
    ])],
    when: ["scanning with 30d retention", ({ root, nowMs }) =>
      archiveOldSessions({ roots: [root], retentionDays: 30, nowMs })],
    then: ["old → .gz (original gone), fresh untouched, data recoverable", (r, { paths }) => {
      const root = paths["old.jsonl"].replace(/\/old\.jsonl$/, "");
      try {
        expect(r.candidates).toBe(1);
        expect(r.archived).toBe(1);
        expect(existsSync(paths["old.jsonl"])).toBe(false);
        expect(existsSync(paths["old.jsonl"] + ".gz")).toBe(true);
        expect(existsSync(paths["fresh.jsonl"])).toBe(true);
        // Round-trips: gunzip restores the original bytes.
        const restored = gunzipSync(readFileSync(paths["old.jsonl"] + ".gz")).toString();
        expect(restored).toContain("old.jsonl");
        expect(r.reclaimedBytes).toBeGreaterThan(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("dry run reports candidates but changes nothing", {
    given: ["one old file", () => makeRoot([["old.jsonl", 40]])],
    when: ["dry scanning", ({ root, nowMs }) =>
      archiveOldSessions({ roots: [root], retentionDays: 30, nowMs, dryRun: true })],
    then: ["candidate counted, file still present, no .gz", (r, { paths }) => {
      const root = paths["old.jsonl"].replace(/\/old\.jsonl$/, "");
      try {
        expect(r.candidates).toBe(1);
        expect(r.archived).toBe(0);
        expect(existsSync(paths["old.jsonl"])).toBe(true);
        expect(existsSync(paths["old.jsonl"] + ".gz")).toBe(false);
        expect(r.reclaimedBytes).toBeGreaterThan(0); // estimated
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("ignores already-gzipped files", {
    given: ["an old .jsonl.gz (not a .jsonl)", () => makeRoot([["old.jsonl.gz", 40]])],
    when: ["scanning", ({ root, nowMs }) =>
      archiveOldSessions({ roots: [root], retentionDays: 30, nowMs })],
    then: ["not scanned as a candidate", (r, { paths }) => {
      const root = paths["old.jsonl.gz"].replace(/\/old\.jsonl\.gz$/, "");
      rmSync(root, { recursive: true, force: true });
      expect(r.scanned).toBe(0);
      expect(r.candidates).toBe(0);
    }],
  });

  unit("recurses nested session dirs (codex YYYY/MM/DD layout)", {
    given: ["a nested old rollout file", () => {
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
    when: ["scanning", ({ root, nowMs }) =>
      archiveOldSessions({ roots: [root], retentionDays: 30, nowMs })],
    then: ["nested file found + archived", (r, { root }) => {
      rmSync(root, { recursive: true, force: true });
      expect(r.candidates).toBe(1);
      expect(r.archived).toBe(1);
    }],
  });
});

feature("formatJanitorResult", () => {
  unit("nothing-to-do message", {
    given: ["a clean result", () => ({ scanned: 5, candidates: 0, archived: 0, failed: 0, reclaimedBytes: 0, retentionDays: 30, dryRun: false })],
    when: ["formatting", (r) => formatJanitorResult(r)],
    then: ["mentions retention + scan count", (s) => {
      expect(s).toContain("30d");
      expect(s).toContain("5 files scanned");
    }],
  });

  unit("archived summary reports MB + counts", {
    given: ["an archive result", () => ({ scanned: 10, candidates: 4, archived: 4, failed: 0, reclaimedBytes: 5 * 1024 * 1024, retentionDays: 30, dryRun: false })],
    when: ["formatting", (r) => formatJanitorResult(r)],
    then: ["shows archived count + MB", (s) => {
      expect(s).toContain("archived 4/4");
      expect(s).toContain("5.0MB");
    }],
  });
});
