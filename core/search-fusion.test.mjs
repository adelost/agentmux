import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyQuery, fuseRankings, semanticSearchHits } from "./search-fusion.mjs";
import { semanticQuery } from "./search-embedder.mjs";

feature("lexical and semantic fusion", () => {
  unit("identifiers and short names stay lexical; questions use both layers", {
    given: ["exact lookups and natural questions", () => ({
      exact: ["GRACE_S", "STREAMA-HIT.bat", "talktype whisper", "\"Hard to pin down.\""],
      natural: ["vem organiserade Bumbi", "hur gammal är Axel", "varför såg det ut som 191 commits ändrade lokalt"],
    })],
    when: ["classifying", ({ exact, natural }) => ({ exact: exact.map(classifyQuery), natural: natural.map(classifyQuery) })],
    then: ["each lands in its class", ({ exact, natural }) => {
      expect(new Set(exact)).toEqual(new Set(["exact"]));
      expect(new Set(natural)).toEqual(new Set(["natural"]));
    }],
  });

  unit("a unit both layers rank highly leads; a clear lexical winner stays above a semantic-only unit", {
    given: ["a lexical and a semantic ranking", () => {
      const unitAt = (path, start) => ({ path, line: 1, passage: { start } });
      return {
        lexical: [{ ...unitAt("/clear.md", 0), layer: "passage", score: 30 }, { ...unitAt("/both.md", 5), layer: "passage", score: 20 },
          { ...unitAt("/weak.md", 0), layer: "passage", score: 9 }],
        semantic: [{ ...unitAt("/sem.md", 0), layer: "sem", sim: 0.86 }, { ...unitAt("/both.md", 5), layer: "sem", sim: 0.85 },
          { ...unitAt("/far.md", 0), layer: "sem", sim: 0.80 }],
      };
    }],
    when: ["fusing", ({ lexical, semantic }) => fuseRankings(lexical, semantic)],
    then: ["shared unit first and as one hit, then the lexical winner, then the semantic-only unit", (hits) => {
      expect(hits.slice(0, 3).map((hit) => hit.path)).toEqual(["/both.md", "/clear.md", "/sem.md"]);
      expect(hits[0].fusedLayers).toEqual(["passage", "sem"]);
    }],
  });

  component("a semantic unit is a verified passage only while its file is unchanged", {
    given: ["an indexed file that is then edited", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-fusion-"));
      const path = join(dir, "note.md");
      writeFileSync(path, "# Not\n- Svaret står här.\n");
      const info = statSync(path);
      const hit = { path, line: 2, root: "memory", weight: 3, date: null, sim: 0.9,
        unit: { start: 6, length: "- Svaret står här.".length, section: { start: 0, end: info.size } },
        indexedMtimeMs: info.mtimeMs, indexedSize: info.size };
      return { dir, path, hit };
    }],
    when: ["binding before and after the edit", ({ path, hit }) => {
      const before = semanticSearchHits([hit]);
      writeFileSync(path, "# Not\n- Nytt först.\n- Svaret står här.\n");
      return { before, after: semanticSearchHits([hit]) };
    }],
    then: ["the edited file is shown by line, never with stale offsets", ({ before, after }, { dir }) => {
      try {
        expect(before[0]).toMatchObject({ snippet: "- Svaret står här.", passage: { start: 6 } });
        expect(after[0].passage).toBeUndefined();
        expect(after[0].snippet).toBe("- Nytt först.");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  component("a cold semantic layer answers lexically and says why", {
    given: ["no daemon running", () => ({ started: [] })],
    when: ["querying without waiting", async (state) => semanticQuery("vem organiserade Bumbi", {
      dir: mkdtempSync(join(tmpdir(), "amux-noindex-")), waitMs: 0, start: (args) => state.started.push(args),
    })],
    then: ["no hits, an explicit reason and a background start", (result, state) => {
      expect(result.hits).toEqual([]);
      expect(result.unavailable).toMatch(/warming up.*lexical only/u);
      expect(state.started).toHaveLength(1);
    }],
  });
});
