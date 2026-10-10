import { component, feature, unit, expect } from "bdd-vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { archiveMemory, archiveSummary, buildArchiveStub, parseArchiveStub } from "./memory-archive.mjs";
import { lintMemory } from "./memory-lint.mjs";

const NOW = new Date("2026-07-11T10:00:00+02:00");

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "amux-memory-archive-"));
  mkdirSync(join(root, "memory", "dream"), { recursive: true });
  return root;
}

function day(dateKey, count, { summary = `Full notes for ${dateKey}.`, extra = [] } = {}) {
  return [
    "<!-- template: daily -->", ...(summary ? [`> summary: ${summary}`] : []), "> why: test", `# ${dateKey}`,
    "## Händelser", "## Beslut om kameran", "- Mattias valde A", ...extra,
    ...Array.from({ length: count }, (_, i) => `- detail ${i} åäö`),
  ].join("\n") + "\n";
}

const lines = (text) => text.trimEnd().split("\n");

feature("memory archive", () => {
  component("an old oversized day moves byte-for-byte and leaves a five-line stub", {
    given: ["an old day with a Dream digest", () => {
      const root = workspace();
      const original = day("2026-05-01", 60);
      writeFileSync(join(root, "memory", "2026-05-01.md"), original);
      writeFileSync(join(root, "memory", "dream", "2026-05-01-run.md"), "## Underlag och kontinuitet\n## Nattens beslut\n");
      return { root, original };
    }],
    when: ["archiving", ({ root }) => ({ root, result: archiveMemory(root, { dryRun: false, now: NOW }) })],
    then: ["the archive is identical, the stub links it and lint sees no backlog", ({ root, result }) => {
      expect(result.archived.map((row) => row.dateKey)).toEqual(["2026-05-01"]);
      const archived = readFileSync(join(root, "memory", "archive", "daily", "2026-05-01.md"));
      expect(archived.equals(Buffer.from(day("2026-05-01", 60)))).toBe(true);
      const stub = readFileSync(join(root, "memory", "2026-05-01.md"), "utf-8");
      expect(lines(stub).length).toBeLessThanOrEqual(5);
      expect(stub).toContain("> summary: Full notes for 2026-05-01.");
      expect(stub).toContain("`memory/archive/daily/2026-05-01.md`");
      expect(stub).toContain("`memory/dream/2026-05-01-run.md`");
      expect(parseArchiveStub(stub)?.archivePath).toBe("memory/archive/daily/2026-05-01.md");
      expect(lintMemory(root, { now: NOW, home: join(root, "home") }).compactable).toEqual([]);
    }],
  });

  component("today, recent, archived and todo-carrying days stay where they are", {
    given: ["one day of each kind", () => {
      const root = workspace();
      writeFileSync(join(root, "memory", "2026-07-11.md"), day("2026-07-11", 200));
      writeFileSync(join(root, "memory", "2026-06-30.md"), day("2026-06-30", 200));
      writeFileSync(join(root, "memory", "2026-05-03.md"), day("2026-05-03", 60, { extra: ["- [ ] ring Erika"] }));
      writeFileSync(join(root, "memory", "2026-05-04.md"), buildArchiveStub({ dateKey: "2026-05-04", summary: "x", sha: "0".repeat(64) }));
      writeFileSync(join(root, "memory", "2026-05-05.md"), day("2026-05-05", 5));
      return { root };
    }],
    when: ["archiving", ({ root }) => archiveMemory(root, { dryRun: false, now: NOW })],
    then: ["nothing moves and the todo day is reported as blocked", (result) => {
      expect(result.archived).toEqual([]);
      expect(result.blocked.map((row) => [row.dateKey, row.reason])).toEqual([["2026-05-03", "1 open todo(s)"]]);
    }],
  });

  component("a run is bounded and a dry run changes nothing", {
    given: ["three old oversized days", () => {
      const root = workspace();
      for (const key of ["2026-05-01", "2026-05-02", "2026-05-03"]) writeFileSync(join(root, "memory", `${key}.md`), day(key, 40));
      return { root };
    }],
    when: ["a dry run, then a run of two", ({ root }) => ({
      root,
      dry: archiveMemory(root, { dryRun: true, now: NOW }),
      run: archiveMemory(root, { dryRun: false, now: NOW, max: 2 }),
    })],
    then: ["the dry run plans all three, the real run moves the oldest two", ({ root, dry, run }) => {
      expect(dry.eligible.map((row) => row.dateKey)).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
      expect(run.archived.map((row) => row.dateKey)).toEqual(["2026-05-01", "2026-05-02"]);
      expect(run.remaining).toBe(1);
      expect(existsSync(join(root, "memory", "archive", "daily", "2026-05-03.md"))).toBe(false);
    }],
  });

  component("a different file already in the archive is never overwritten", {
    given: ["an old day whose archive slot holds other content", () => {
      const root = workspace();
      writeFileSync(join(root, "memory", "2026-05-01.md"), day("2026-05-01", 40));
      mkdirSync(join(root, "memory", "archive", "daily"), { recursive: true });
      writeFileSync(join(root, "memory", "archive", "daily", "2026-05-01.md"), "other\n");
      return { root };
    }],
    when: ["archiving", ({ root }) => ({ root, result: archiveMemory(root, { dryRun: false, now: NOW }) })],
    then: ["the run fails that day and both files are untouched", ({ root, result }) => {
      expect(result.failed[0].error).toContain("exists with different content");
      expect(readFileSync(join(root, "memory", "archive", "daily", "2026-05-01.md"), "utf-8")).toBe("other\n");
      expect(readFileSync(join(root, "memory", "2026-05-01.md"), "utf-8")).toBe(day("2026-05-01", 40));
    }],
  });

  unit("a day without its own summary borrows the digest's headings, then its own", {
    given: ["a day without summary", () => day("2026-05-01", 3, { summary: "" })],
    when: ["summarizing with and without a digest", (text) => ({
      digest: archiveSummary(text, ["## Underlag och kontinuitet\n## Kameran valdes\n## Hoppet\n"]),
      own: archiveSummary(text, []),
      placeholder: archiveSummary("> summary: {Vad som hände idag — en mening.}\n## Händelser\n", []),
    })],
    then: ["real headings, never the template placeholder", ({ digest, own, placeholder }) => {
      expect(digest).toBe("Kameran valdes; Hoppet");
      expect(own).toBe("Beslut om kameran");
      expect(placeholder).toBe("Arkiverad dagfil");
    }],
  });
});
