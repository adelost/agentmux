import { component, feature, unit, expect } from "bdd-vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compactMemory, foldCompactedToLimit, parseClaudeResult, sanitizeCompactorOutput, validateCompactedDaily } from "./memory-compact.mjs";

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
  component("the public path refuses hidden model execution before touching git", {
    given: ["one oversized old daily file", () => {
      const root = gitWorkspace();
      const path = join(root, "memory", "2026-05-01.md");
      writeFileSync(path, daily("2026-05-01"));
      return { root, before: runGit(root, "status", "--short") };
    }],
    when: ["running without an explicitly injected deterministic generator", async ({ root }) => {
      try { await compactMemory(root, { now: NOW }); return null; }
      catch (error) { return error; }
    }],
    then: ["it fails closed with the worktree unchanged", (error, { root, before }) => {
      expect(error?.message).toContain("memory-compactor-disabled");
      expect(runGit(root, "status", "--short")).toBe(before);
    }],
  });

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

feature("foldCompactedToLimit: deterministic bound without losing protected content", () => {
  const bigAnswer = (dateKey, extra = 12) => [
    "<!-- template: daily -->", "> summary: dense.", "> why: archive.", `# ${dateKey}`,
    "## Händelser",
    ...Array.from({ length: extra }, (_, i) => `- detalj ${i}`),
    "## Pågående", "- [ ] behåll mig", "## Dokumenterat", "- se `memory/references/x.md`",
  ].join("\n");

  component("an over-limit answer keeps every todo, link, heading, and the explicit bank marker", {
    given: ["a 22-line answer over a 15-line physical cap", () => bigAnswer("2026-05-01")],
    when: ["folding and revalidating", (answer) => {
      const folded = foldCompactedToLimit(answer, { targetLines: 10, dateKey: "2026-05-01" });
      return {
        folded,
        lines: folded.content.trimEnd().split("\n").length,
        valid: validateCompactedDaily(
          bigAnswer("2026-05-01") + "\n- [ ] behåll mig\n- se `memory/references/x.md`\n",
          folded.content,
          { targetLines: 10, dateKey: "2026-05-01" },
        ),
      };
    }],
    then: ["bounded, valid, and honest about what moved to git history", (r) => {
      expect(r.folded.folded).toBe(true);
      expect(r.lines).toBeLessThanOrEqual(15);
      expect(r.valid.ok).toBe(true);
      expect(r.folded.content).toContain("- [ ] behåll mig");
      expect(r.folded.content).toContain("memory/references/x.md");
      expect(r.folded.content).toContain("rader bankade i git-historiken");
      expect(r.folded.dropped).toBeGreaterThan(0);
    }],
  });

  component("an answer already within the cap passes through untouched", {
    given: ["a small answer", () => compacted("2026-05-01")],
    when: ["folding", (answer) => foldCompactedToLimit(answer, { targetLines: 10, dateKey: "2026-05-01" })],
    then: ["no fold, no marker", (r) => {
      expect(r.folded).toBe(false);
      expect(r.dropped).toBe(0);
      expect(r.content).toBe(compacted("2026-05-01"));
    }],
  });

  component("a full compaction of the 15-19 line failure shape now succeeds", {
    given: ["a dirty repo with the real failure shape", () => {
      const root = gitWorkspace();
      const path = join(root, "memory", "2026-05-01.md");
      const original = daily("2026-05-01");
      writeFileSync(path, original);
      return { root, path, original };
    }],
    when: ["the fake LLM answers 17 physical lines over a 15-line cap", async ({ root, path }) => {
      const answer = [
        "<!-- template: daily -->", "> summary: dense.", "> why: archive.", "# 2026-05-01",
        "## Händelser", ...Array.from({ length: 10 }, (_, i) => `- detalj ${i}`),
        "## Pågående", "- none", "## Dokumenterat", "- none",
      ].join("\n");
      return { path, result: await compactMemory(root, { now: NOW, generate: async () => answer }) };
    }],
    then: ["folded to the cap instead of failed, and committed", ({ path, result }) => {
      expect(result.failed).toHaveLength(0);
      expect(result.compacted).toHaveLength(1);
      expect(result.compactCommit).toBeTruthy();
      const written = readFileSync(path, "utf-8").trimEnd().split("\n").length;
      expect(written).toBeLessThanOrEqual(15);
    }],
  });
});

feature("fold identity: duplicate optional rows never exceed the cap", () => {
  component("twelve identical optional rows are bounded by index, not by text", {
    given: ["an answer full of identical '- samma' rows", () => [
      "<!-- template: daily -->", "> summary: dense.", "> why: archive.", "# 2026-05-01",
      "## Händelser", ...Array.from({ length: 12 }, () => "- samma"),
      "## Pågående", "- [ ] behåll mig", "## Dokumenterat", "- se `memory/references/x.md`",
    ].join("\n")],
    when: ["folding", (answer) => foldCompactedToLimit(answer, { targetLines: 10, dateKey: "2026-05-01" })],
    then: ["exactly 15 lines, marker present, protected content intact", (r) => {
      const lines = r.content.trimEnd().split("\n");
      expect(lines.length).toBe(15);
      expect(r.folded).toBe(true);
      expect(r.dropped).toBeGreaterThan(0);
      expect(r.content).toContain("rader bankade i git-historiken");
      expect(r.content).toContain("- [ ] behåll mig");
      expect(r.content).toContain("memory/references/x.md");
    }],
  });
});

feature("sanitizeCompactorOutput: fences and preamble never break the template anchor", () => {
  unit("preamble before the tag is dropped, fences stripped, content kept", {
    given: ["three real answer shapes", () => ({
      fenced: "```markdown\n<!-- template: daily -->\n> summary: x\n```\n",
      preamble: "Här är kompakten:\n<!-- template: daily -->\n> summary: x\n",
      clean: "<!-- template: daily -->\n> summary: x\n",
    })],
    when: ["sanitizing", (shapes) => Object.fromEntries(
      Object.entries(shapes).map(([key, value]) => [key, sanitizeCompactorOutput(value)]),
    )],
    then: ["every shape starts with the template tag and keeps its content", (r) => {
      for (const value of Object.values(r)) {
        expect(value.startsWith("<!-- template: daily -->")).toBe(true);
        expect(value).toContain("> summary: x");
      }
    }],
  });
});

feature("fenced and overlong answers compact through sanitize plus fold", () => {
  component("a fenced answer with 19 physical lines lands valid and bounded", {
    given: ["a dirty repo and an oversized daily", () => {
      const root = gitWorkspace();
      const path = join(root, "memory", "2026-05-01.md");
      const original = daily("2026-05-01");
      writeFileSync(path, original);
      return { root, path, original };
    }],
    when: ["the fake LLM wraps 19 lines in a markdown fence", async ({ root, path }) => {
      const fenced = [
        "```markdown",
        "<!-- template: daily -->", "> summary: dense.", "> why: archive.", "# 2026-05-01",
        "## Händelser", ...Array.from({ length: 12 }, (_, i) => `- detalj ${i}`),
        "## Pågående", "- none", "## Dokumenterat", "- none",
        "```",
      ].join("\n");
      return { path, result: await compactMemory(root, { now: NOW, generate: async () => fenced }) };
    }],
    then: ["sanitized, folded to the cap, committed, no structural failure", ({ path, result }) => {
      expect(result.failed).toHaveLength(0);
      expect(result.compacted).toHaveLength(1);
      expect(result.compactCommit).toBeTruthy();
      const written = readFileSync(path, "utf-8");
      expect(written.trimEnd().split("\n").length).toBeLessThanOrEqual(15);
      expect(written.startsWith("<!-- template: daily -->")).toBe(true);
    }],
  });
});
