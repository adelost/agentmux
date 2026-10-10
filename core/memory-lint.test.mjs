import { feature, unit, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";
import { buildArchiveStub } from "./memory-archive.mjs";
import { lintMemory, writeMemoryDailyReport } from "./memory-lint.mjs";

const NOW = new Date("2026-07-11T10:00:00+02:00");

function workspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-memory-lint-"));
  mkdirSync(join(root, "memory", "references"), { recursive: true });
  mkdirSync(join(root, "memory", "people"), { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), "> summary: index\n> why: test\n\n# Index\n");
  writeFileSync(join(root, "memory", "TEMPLATE.md"), [
    "> summary: template", "> why: test", "", "## Händelser <!-- required -->",
    "## Pågående <!-- required -->", "## Dokumenterat <!-- required -->", "",
  ].join("\n"));
  writeFileSync(join(root, "memory", "people", "TEMPLATE.md"), "> summary: template\n> why: test\n");
  writeFileSync(join(root, "memory", "references", "TEMPLATE.md"), "> summary: template\n> why: test\n");
  writeFileSync(join(root, "memory", "people.md"), "> summary: people\n> why: test\n\n# People\n");
  return root;
}

function daily(lines = 4) {
  return [
    "<!-- template: daily -->", "> summary: day", "> why: test", "# 2026-06-01",
    "## Händelser", "- happened", "## Pågående", "- none", "## Dokumenterat", "- none",
    ...Array.from({ length: Math.max(0, lines - 10) }, (_, i) => `- detail ${i}`),
  ].join("\n") + "\n";
}

feature("memory lint", () => {
  unit("old oversized daily files become ordered compact candidates", {
    given: ["two oversized old files and protected today", () => {
      const root = workspaceFixture();
      writeFileSync(join(root, "memory", "2026-05-02.md"), daily(35));
      writeFileSync(join(root, "memory", "2026-05-01.md"), daily(40));
      writeFileSync(join(root, "memory", "2026-07-11.md"), daily(150));
      return { root };
    }],
    when: ["linting", ({ root }) => lintMemory(root, { now: NOW, home: join(root, "home") })],
    then: ["only old files are candidates, oldest first, target 5", (result) => {
      expect(result.compactable.map((row) => row.dateKey)).toEqual(["2026-05-01", "2026-05-02"]);
      expect(result.compactable.every((row) => row.targetLines === 5)).toBe(true);
      expect(result.findings.some((row) => row.code === "daily_protected_large")).toBe(true);
    }],
  });

  unit("a recorded dream failure with no successful run is a warning, not a status line", {
    given: ["today's file carrying only a gap marker", () => {
      const root = workspaceFixture();
      writeFileSync(join(root, "memory", "2026-07-11.md"),
        `${daily(12)}<!-- amux-dream-failed:2026-07-11 04:00 dream-owner-not-idle:claw:3 -->\n`);
      return { root };
    }],
    when: ["linting", ({ root }) => lintMemory(root, { now: NOW, home: join(root, "home") })],
    then: ["the lost night is counted as a warning with its reason", (result) => {
      const finding = result.findings.find((row) => row.code === "dream_gap");
      expect(finding?.severity).toBe("warning");
      expect(finding?.message).toContain("dream-owner-not-idle:claw:3");
      expect(result.summary.warnings).toBeGreaterThan(0);
      expect(result.dreamGap).toMatchObject({ date: "2026-07-11", time: "04:00" });
    }],
  });

  unit("a failure followed by a successful run is not reported as a lost night", {
    given: ["today's file with both a gap marker and a run sentinel", () => {
      const root = workspaceFixture();
      writeFileSync(join(root, "memory", "2026-07-11.md"), [
        daily(12),
        "<!-- amux-dream-failed:2026-07-11 04:00 dream-owner-not-idle:claw:3 -->",
        "<!-- amux-dream-run:2026-07-11 05:00 (7 panes ok / 0 failed) -->",
        "",
      ].join("\n"));
      return { root };
    }],
    when: ["linting", ({ root }) => lintMemory(root, { now: NOW, home: join(root, "home") })],
    then: ["the retry closes the gap", (result) => {
      expect(result.findings.some((row) => row.code === "dream_gap")).toBe(false);
      expect(result.dream).toMatchObject({ date: "2026-07-11", ok: 7 });
    }],
  });

  unit("frontmatter descriptions satisfy the summary contract", {
    given: ["a reference with modern frontmatter", () => {
      const root = workspaceFixture();
      writeFileSync(join(root, "memory", "references", "modern.md"), "---\ndescription: Modern note\n---\n# Note\n");
      return { root };
    }],
    when: ["linting", ({ root }) => lintMemory(root, { now: NOW, home: join(root, "home") })],
    then: ["no summary warning for that file", (result) => {
      expect(result.findings.some((row) => row.file === "memory/references/modern.md" && row.code === "summary_missing")).toBe(false);
    }],
  });

  unit("missing daily structure and broken links fail loud", {
    given: ["a malformed daily and a broken concrete memory link", () => {
      const root = workspaceFixture();
      writeFileSync(join(root, "memory", "2026-07-09.md"), "<!-- template: daily -->\n> summary: bad\n> why: test\n# Day\n");
      writeFileSync(join(root, "notes.md"), "> summary: links\n> why: test\n\nSee `memory/references/missing.md`.\n");
      return { root };
    }],
    when: ["linting", ({ root }) => lintMemory(root, { now: NOW, home: join(root, "home") })],
    then: ["both classes are warnings", (result) => {
      expect(result.findings.some((row) => row.code === "daily_structure")).toBe(true);
      expect(result.findings.some((row) => row.code === "broken_link")).toBe(true);
      expect(result.summary.warnings).toBeGreaterThan(0);
    }],
  });

  unit("daily report is idempotent and replaces the same date marker", {
    given: ["today's daily file", () => {
      const root = workspaceFixture();
      const path = join(root, "memory", "2026-07-11.md");
      writeFileSync(path, daily(12));
      const result = lintMemory(root, { now: NOW, home: join(root, "home") });
      return { root, path, result };
    }],
    when: ["writing two reports", ({ root, path, result }) => {
      writeMemoryDailyReport(root, result, { archived: 1, now: NOW });
      writeMemoryDailyReport(root, result, { archived: 2, now: NOW });
      return readFileSync(path, "utf-8");
    }],
    then: ["one marker remains with the latest count", (content) => {
      expect(content.match(/amux-memory-status:/g)).toHaveLength(1);
      // The nightly old-band actor is the lossless archive now, so the line
      // reports archived days (Mattias 2026-07-11: a warning needs an actor).
      expect(content).toContain("arkiverade 2 inatt");
    }],
  });

  unit("a recent oversized day is information, not a warning without an actor", {
    given: ["a 150-line day from two weeks ago", () => {
      const root = workspaceFixture();
      writeFileSync(join(root, "memory", "2026-06-27.md"), daily(150));
      return { root };
    }],
    when: ["linting", ({ root }) => lintMemory(root, { now: NOW, home: join(root, "home") })],
    then: ["no compact warning and no backlog entry, only daily_large info", (result) => {
      expect(result.compactable).toEqual([]);
      expect(result.findings.some((row) => row.code === "daily_compact")).toBe(false);
      expect(result.findings.find((row) => row.code === "daily_large")?.severity).toBe("info");
    }],
  });

  unit("a long section in today's file is named for its writer", {
    given: ["today with a 20-line section", () => {
      const root = workspaceFixture();
      writeFileSync(join(root, "memory", "2026-07-11.md"), [
        daily(10).trimEnd(), "## Lång rapport (lsrc:2)",
        ...Array.from({ length: 20 }, (_, i) => `- rad ${i}`), "## Kort", "- en rad", "",
      ].join("\n"));
      return { root };
    }],
    when: ["linting", ({ root }) => lintMemory(root, { now: NOW, home: join(root, "home") })],
    then: ["one info names the long section only", (result) => {
      const rows = result.findings.filter((row) => row.code === "daily_section_long");
      expect(rows).toHaveLength(1);
      expect(rows[0].severity).toBe("info");
      expect(rows[0].message).toContain("Lång rapport (lsrc:2)");
    }],
  });

  unit("an archive stub is compact while its original exists, and loud when it does not", {
    given: ["two stubs, one with its archived original", () => {
      const root = workspaceFixture();
      const original = daily(60);
      mkdirSync(join(root, "memory", "archive", "daily"), { recursive: true });
      writeFileSync(join(root, "memory", "archive", "daily", "2026-05-01.md"), original);
      writeFileSync(join(root, "memory", "2026-05-01.md"), buildArchiveStub({
        dateKey: "2026-05-01", summary: "day", sha: createHash("sha256").update(original).digest("hex") }));
      writeFileSync(join(root, "memory", "2026-05-02.md"), buildArchiveStub({
        dateKey: "2026-05-02", summary: "day", sha: "0".repeat(64) }));
      return { root };
    }],
    when: ["linting", ({ root }) => lintMemory(root, { now: NOW, home: join(root, "home") })],
    then: ["no backlog, and only the stub without an original warns", (result) => {
      expect(result.compactable).toEqual([]);
      const archived = result.findings.filter((row) => row.code.startsWith("archive_"));
      expect(archived.map((row) => [row.code, row.file])).toEqual([["archive_missing", "memory/2026-05-02.md"]]);
    }],
  });
});
