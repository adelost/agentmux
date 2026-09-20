import { component, expect, feature, unit } from "bdd-vitest";
import { defineDecisionTable, decisionPoints, decide } from "@v1d/product-spec";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { memoryTopicDeclaration, memoryTopicRules } from "../policies/memory-topics.mjs";
import { inspectTopics, topicHash } from "./memory-topics.mjs";
import { expandMemoryTopic, mergeTopicHits, searchMemoryTopics } from "./memory-topic-search.mjs";
import { publishMemoryTopic } from "./memory-topic-publish.mjs";
import { cmdSearch } from "../cli/search.mjs";
import { loadLastResults } from "./search-state.mjs";

const cleanups = [];
afterEach(() => { vi.restoreAllMocks(); for (const path of cleanups.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-topics-"));
  cleanups.push(root);
  mkdirSync(join(root, "memory"));
  const source = join(root, "memory", "source.md");
  const original = "# Browser\nProduct tests use the test profile.\n";
  writeFileSync(source, original);
  const text = `---\nversion: 1\nid: browser\ntitle: Browser profiles\nsummary: Isolate product tests from signed-in accounts.\nasOf: 2026-09-20\nstatus: ACTIVE\naliases: [browser profile, isolated tests]\nsources:\n  - path: memory/source.md\n    sha256: ${topicHash(original)}\n    from: 1\n    to: 2\n---\n# Browser profiles\nProduct tests use the test profile.\n`;
  const candidate = join(root, "browser.md");
  writeFileSync(candidate, text);
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, `search:\n  roots:\n    - name: memory\n      path: ${join(root, "memory")}\n      glob: '*.md'\n      semantic: true\n`);
  return { root, source, candidate, text, configPath, statePath: join(root, "search.json") };
}

feature("source-bound topic retrieval", () => {
  component("shared word prefixes do not invent a topic match", {
    given: ["a note about summarizing", () => {
      const f = fixture(); writeFileSync(f.candidate, f.text.replace("aliases: [browser profile, isolated tests]", "aliases: [sammanfatta]"));
      publishMemoryTopic(f.root, f.candidate); return f;
    }],
    when: ["searching for the Swedish word samma", f => searchMemoryTopics("samma", f.root)],
    then: ["samma is not mistaken for sammanfatta", result => expect(result.hits).toEqual([])],
  });
  unit("policy covers every state and refuses holes or overlaps", {
    then: ["only reviewed active source matches are eligible", () => {
      const results = decisionPoints(memoryTopicRules.axes).map(facts => decide(memoryTopicRules, facts));
      expect(results).toHaveLength(18);
      expect(results.filter(result => result.values.action === "SERVE")).toHaveLength(1);
      expect(() => defineDecisionTable({ ...memoryTopicDeclaration, cells: memoryTopicDeclaration.cells.slice(1) })).toThrow(/no cell/);
      expect(() => defineDecisionTable({ ...memoryTopicDeclaration, cells: [...memoryTopicDeclaration.cells, memoryTopicDeclaration.cells[0]] })).toThrow();
    }],
  });

  component("a changed source cannot be served or republished", {
    given: ["a published source-bound topic", () => { const f = fixture(); publishMemoryTopic(f.root, f.candidate); return f; }],
    when: ["the original decision changes", f => {
      const hit = searchMemoryTopics("browser profiles", f.root).hits[0];
      writeFileSync(f.source, "# Browser\nA later decision replaces the old rule.\n");
      return { f, hit, results: searchMemoryTopics("browser profiles", f.root) };
    }],
    then: ["retrieval and last-result expansion reject the old summary", ({ f, hit, results }) => {
      expect(results.hits).toEqual([]);
      expect(results.excluded[0].state).toBe("STALE");
      expect(expandMemoryTopic(hit)).not.toContain("Product tests use the test profile.");
      expect(() => publishMemoryTopic(f.root, f.candidate)).toThrow(/STALE/);
    }],
  });

  for (const state of ["SUPERSEDED", "CONFLICT"]) component(`${state} summaries stay out of search`, {
    given: ["a topic with a declared unresolved or retired decision", () => {
      const f = fixture(); writeFileSync(f.candidate, f.text.replace("status: ACTIVE", `status: ${state}`)); return f;
    }],
    when: ["publishing the declared state", f => { publishMemoryTopic(f.root, f.candidate); return f; }],
    then: ["the state is visible while its content is withheld", f => {
      expect(inspectTopics(f.root)[0].state).toBe(state);
      expect(searchMemoryTopics("browser profiles", f.root).hits).toEqual([]);
    }],
  });

  component("replacement preserves previous bytes and invalidates saved results", {
    given: ["an existing topic and a saved hit", () => {
      const f = fixture(); publishMemoryTopic(f.root, f.candidate);
      return { ...f, hit: searchMemoryTopics("browser profiles", f.root).hits[0] };
    }],
    when: ["a reviewed text revision is published", f => {
      writeFileSync(f.candidate, f.text.replace("# Browser profiles", "# Updated browser profiles"));
      publishMemoryTopic(f.root, f.candidate); return f;
    }],
    then: ["archive bytes match and old search results ask for a fresh read", f => {
      expect(readFileSync(join(f.root, "memory/topics/.history/browser", `${topicHash(f.text)}.md`), "utf8")).toBe(f.text);
      expect(expandMemoryTopic(f.hit)).toContain("changed since search");
    }],
  });

  component("malformed or escaped source metadata is refused before publication", {
    given: ["a source reference escaping the workspace", () => {
      const f = fixture(); writeFileSync(f.candidate, f.text.replace("memory/source.md", "../source.md")); return f;
    }],
    when: ["attempting to publish", f => () => publishMemoryTopic(f.root, f.candidate)],
    then: ["the schema refuses it", run => expect(run).toThrow(/INVALID/)],
  });

  component("normal CLI search and expansion use topics but stale lexical matches cannot bypass validation", {
    given: ["a real memory root with a topic", () => { const f = fixture(); publishMemoryTopic(f.root, f.candidate); return f; }],
    when: ["searching, then changing the cited file", async f => {
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const flags = { workspace: f.root, source: "memory", show: "1", max: 3 };
      await cmdSearch({ configPath: f.configPath }, "browser profiles", flags, { statePath: f.statePath });
      const first = output.mock.calls.flat().join("\n");
      writeFileSync(f.source, "# Browser profiles\nThe later original remains searchable.\n");
      output.mockClear();
      await cmdSearch({ configPath: f.configPath }, "browser profiles", flags, { statePath: f.statePath });
      return { f, first, second: output.mock.calls.flat().join("\n"), hits: loadLastResults(f.statePath).hits };
    }],
    then: ["topic evidence appears first, later only the changed original survives", ({ first, second, hits }) => {
      expect(first).toContain("Original evidence:");
      expect(first).toContain("verified-sources");
      expect(second).toContain("later original remains searchable");
      expect(second).not.toContain("Product tests use the test profile.");
      expect(hits.every(hit => !hit.path.includes("/topics/"))).toBe(true);
    }],
  });

  unit("original evidence keeps a slot beside topic orientation", {
    when: ["merging three topics and original results into three slots", () => mergeTopicHits([{ path: "source" }], [{ path: "a" }, { path: "b" }, { path: "c" }], 3)],
    then: ["the original is not crowded out", hits => expect(hits.map(hit => hit.path)).toEqual(["a", "b", "source"])],
  });
});
