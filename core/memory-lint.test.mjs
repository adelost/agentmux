import { feature, unit, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
      writeMemoryDailyReport(root, result, { compacted: 1, now: NOW });
      writeMemoryDailyReport(root, result, { compacted: 2, now: NOW });
      return readFileSync(path, "utf-8");
    }],
    then: ["one marker remains with the latest count", (content) => {
      expect(content.match(/amux-memory-status:/g)).toHaveLength(1);
      expect(content).toContain("komprimerade 2 inatt");
    }],
  });
});
