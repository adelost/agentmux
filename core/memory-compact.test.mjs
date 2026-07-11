import { component, feature, unit, expect } from "bdd-vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compactMemory, parseClaudeResult, validateCompactedDaily } from "./memory-compact.mjs";

const NOW = new Date("2026-07-11T10:00:00+02:00");
const runGit = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();

function daily(dateKey, count = 40) {
  return [
    "<!-- template: daily -->", `> summary: Full notes for ${dateKey}.`, "> why: Test archive.", `# ${dateKey}`,
    "## Händelser", "- Important decision", "## Pågående", "- none", "## Dokumenterat", "- none",
    ...Array.from({ length: count - 10 }, (_, i) => `- Raw detail ${i}`),
  ].join("\n") + "\n";
}

function compacted(dateKey) {
  return [
    "<!-- template: daily -->", "> summary: Important decision retained.", "> why: Test archive.", `# ${dateKey}`,
    "## Händelser", "- Important decision", "## Pågående", "- none", "## Dokumenterat", "- none",
  ].join("\n") + "\n";
}

function gitWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "amux-memory-compact-"));
  mkdirSync(join(root, "memory", "references"), { recursive: true });
  mkdirSync(join(root, "memory", "people"), { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), "> summary: index\n> why: test\n# Index\n");
  writeFileSync(join(root, "memory", "people.md"), "> summary: people\n> why: test\n# People\n");
  writeFileSync(join(root, "memory", "TEMPLATE.md"), [
    "> summary: template", "> why: test", "## Händelser <!-- required -->",
    "## Pågående <!-- required -->", "## Dokumenterat <!-- required -->",
  ].join("\n"));
  writeFileSync(join(root, "memory", "references", "TEMPLATE.md"), "> summary: template\n> why: test\n");
  writeFileSync(join(root, "memory", "people", "TEMPLATE.md"), "> summary: template\n> why: test\n");
  writeFileSync(join(root, "unrelated.txt"), "base\n");
  runGit(root, "init", "-q");
  runGit(root, "config", "user.email", "test@example.com");
  runGit(root, "config", "user.name", "Test");
  runGit(root, "add", ".");
  runGit(root, "commit", "-qm", "initial");
  writeFileSync(join(root, "unrelated.txt"), "user WIP\n");
  return root;
}

feature("daily compaction validation", () => {
  unit("Claude CLI array envelopes yield the final structured output", {
    given: ["the observed safe-mode JSON shape", () => JSON.stringify([
      { type: "system" },
      { type: "result", is_error: false, structured_output: { content: "hello" } },
    ])],
    when: ["parsing", (stdout) => parseClaudeResult(stdout)],
    then: ["content is extracted", (content) => expect(content).toBe("hello")],
  });

  unit("required metadata, todos and links are protected", {
    given: ["an original with an unresolved todo and memory link", () => ({
      original: daily("2026-05-01") + "- [ ] Keep me\n- See `memory/references/keep.md`\n",
      output: compacted("2026-05-01"),
    })],
    when: ["validating", ({ original, output }) => validateCompactedDaily(original, output, {
      dateKey: "2026-05-01", targetLines: 5,
    })],
    then: ["dropped durable facts fail validation", (result) => {
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain("dropped unresolved todo");
      expect(result.errors.join(" ")).toContain("dropped memory link");
    }],
  });
});

feature("compactMemory git safety", () => {
  component("untracked full file is banked before replacement; unrelated WIP stays dirty", {
    given: ["a dirty shared repo and one untracked oversized daily", () => {
      const root = gitWorkspace();
      const path = join(root, "memory", "2026-05-01.md");
      const original = daily("2026-05-01");
      writeFileSync(path, original);
      return { root, path, original };
    }],
    when: ["compacting with a deterministic fake LLM", async ({ root, path, original }) => {
      const result = await compactMemory(root, {
        now: NOW,
        generate: async ({ dateKey }) => compacted(dateKey),
      });
      return { root, path, original, result };
    }],
    then: ["two commits preserve both versions and exclude unrelated WIP", ({ root, path, original, result }) => {
      expect(result.bankCommit).toBeTruthy();
      expect(result.compactCommit).toBeTruthy();
      expect(readFileSync(path, "utf-8")).toBe(compacted("2026-05-01"));
      expect(runGit(root, "show", "HEAD^:memory/2026-05-01.md")).toBe(original.trimEnd());
      expect(runGit(root, "status", "--short")).toContain("unrelated.txt");
      expect(runGit(root, "show", "--name-only", "--format=", "HEAD")).not.toContain("unrelated.txt");
    }],
  });

  component("invalid LLM output leaves the banked full file byte-identical", {
    given: ["an oversized daily", () => {
      const root = gitWorkspace();
      const path = join(root, "memory", "2026-05-01.md");
      const original = daily("2026-05-01");
      writeFileSync(path, original);
      return { root, path, original };
    }],
    when: ["the fake LLM drops required structure", async ({ root, path, original }) => ({
      root, path, original,
      result: await compactMemory(root, { now: NOW, generate: async () => "too short\n" }),
    })],
    then: ["the file is untouched and failure is explicit", ({ path, original, result }) => {
      expect(result.failed).toHaveLength(1);
      expect(result.compactCommit).toBeNull();
      expect(readFileSync(path, "utf-8")).toBe(original);
    }],
  });
});
