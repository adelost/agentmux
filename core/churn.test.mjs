import { component, feature, unit, expect } from "bdd-vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { analyzeChurn, formatChurnReport, runChurnCommand } from "./churn.mjs";

const NOW = Date.parse("2026-07-16T12:00:00.000Z");
const day = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toISOString();

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf-8" }).trim();
}

function commitAt(root, daysAgo, message, mutate) {
  mutate();
  git(root, "add", "-A");
  execFileSync("git", ["-C", root, "commit", "-q", "-m", message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Churn Test",
      GIT_AUTHOR_EMAIL: "churn@example.test",
      GIT_COMMITTER_NAME: "Churn Test",
      GIT_COMMITTER_EMAIL: "churn@example.test",
      GIT_AUTHOR_DATE: day(daysAgo),
      GIT_COMMITTER_DATE: day(daysAgo),
    },
  });
}

function churnRepo() {
  const root = mkdtempSync(join(tmpdir(), "amux-churn-"));
  git(root, "init", "-q", "-b", "main");
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "tests"));
  commitAt(root, 10, "add young tests and hot source", () => {
    writeFileSync(join(root, "src/hot.mjs"), "export const value = 1;\n");
    writeFileSync(join(root, "tests/young.test.mjs"), 'test("young behavior", () => oldPath());\n');
    writeFileSync(join(root, "tests/removed.test.mjs"), 'test("removed behavior", () => true);\n');
  });
  commitAt(root, 9, "touch hotspot twice", () => {
    writeFileSync(join(root, "src/hot.mjs"), "export const value = 2;\n");
  });
  commitAt(root, 8, "touch hotspot three times", () => {
    writeFileSync(join(root, "src/hot.mjs"), "export const value = 3;\n");
  });
  commitAt(root, 7, "rewrite young test", () => {
    writeFileSync(join(root, "tests/young.test.mjs"), 'test("young behavior", () => newPath());\n');
  });
  commitAt(root, 6, "delete young test file", () => {
    rmSync(join(root, "tests/removed.test.mjs"));
  });
  return root;
}

feature("git churn visibility", () => {
  component("reports young rewrites, young file deletion, and code hotspots without writes", {
    given: ["a clean repo with deterministic short-lived tests and one three-commit source file", () => {
      const root = churnRepo();
      return { root, beforeStatus: git(root, "status", "--porcelain"), beforeHead: git(root, "rev-parse", "HEAD") };
    }],
    when: ["analyzing its last 14 days", ({ root }) => analyzeChurn(root, {
      nowMs: NOW, days: 14, youngDays: 14, minCommits: 3, limit: 10,
    })],
    then: ["the factual signals are sorted and the checkout remains byte-identical in git", (result, context) => {
      try {
        expect(result.young.map((event) => ({
          type: event.type, action: event.action, days: event.days, name: event.name,
        }))).toEqual([
          { type: "file", action: "deleted", days: 4, name: null },
          { type: "test", action: "rewritten", days: 3, name: "young behavior" },
        ]);
        expect(result.hotspots).toEqual([{
          path: "src/hot.mjs", commits: 3, days: 14, test: false,
        }]);
        expect(git(context.root, "status", "--porcelain")).toBe(context.beforeStatus);
        expect(git(context.root, "rev-parse", "HEAD")).toBe(context.beforeHead);
      } finally {
        rmSync(context.root, { recursive: true, force: true });
      }
    }],
  });

  unit("formats digest-sized WARN-only lines without judging churn as failure", {
    given: ["one event of each type", () => ({
      days: 14,
      young: [{ type: "test", path: "x.test.mjs", name: "works", action: "rewritten", days: 3 }],
      hotspots: [{ path: "src/x.mjs", commits: 7, days: 14 }],
    })],
    when: ["formatting the report", (report) => formatChurnReport(report)],
    then: ["every signal is one neutral visibility line", (text) => {
      expect(text).toContain("WARN-only · read-only");
      expect(text).toContain("YOUNG_TEST lived 3d · rewritten · x.test.mjs :: works · worth a look");
      expect(text).toContain("HOTSPOT 7 commits/14d · src/x.mjs · worth a look");
      expect(text).toContain("visibility only, exit 0");
    }],
  });

  unit("help is read-only and does not require a repository", {
    given: ["an output collector", () => []],
    when: ["requesting help", (lines) => ({ result: runChurnCommand(["--help"], (line) => lines.push(line)), lines })],
    then: ["usage states the warning-only contract", ({ result, lines }) => {
      expect(result).toBeNull();
      expect(lines.join("\n")).toContain("Findings never fail the command");
      expect(lines.join("\n")).toContain("no repository files are written");
    }],
  });
});
