import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, rankUnits, reindex, semanticModel } from "./search-semantic.mjs";
import { parseGoldenCases } from "./search-eval.mjs";

// A deterministic stand-in for the model: one dimension per keyword.
const KEYWORDS = ["axel", "bumbi", "kassör"];
const fakeEmbed = async (texts) => texts.map((text) => {
  const v = Float32Array.from(KEYWORDS, (word) => (text.toLowerCase().includes(word) ? 1 : 0));
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
});

feature("semantic unit index", () => {
  component("reindex embeds only changed files and a bounded run resumes later", {
    given: ["a memory root with two notes", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-sem-root-"));
      const dir = mkdtempSync(join(tmpdir(), "amux-sem-index-"));
      writeFileSync(join(root, "people.md"), "# People\n**Axel** — systerson\n**Sanna** — kassör\n");
      writeFileSync(join(root, "film.md"), "# Film\n- Bumbi organiserades av Sanna.\n");
      const embedded = [];
      const embed = async (texts, kind) => { embedded.push(...texts); return fakeEmbed(texts, kind); };
      return { roots: [{ name: "memory", path: root, semantic: true, exclude: [], weight: 3 }], root, dir, embed, embedded };
    }],
    when: ["a bounded run, a full run, then a run with nothing changed", async ({ roots, dir, embed, embedded }) => {
      const model = semanticModel("Xenova/multilingual-e5-small");
      const bounded = await reindex(roots, { dir, embed, model, maxUnits: 2 });
      const full = await reindex(roots, { dir, embed, model });
      const before = embedded.length;
      const again = await reindex(roots, { dir, embed, model });
      const index = openIndex(dir);
      const [query] = await fakeEmbed(["vem är kassör"]);
      return { bounded, full, again, newlyEmbedded: embedded.length - before, top: rankUnits(index, query, { k: 1 })[0], complete: index.complete };
    }],
    then: ["the cap defers a file, the next run completes, an unchanged corpus embeds nothing", (result, { root, dir }) => {
      try {
        expect(result.bounded.deferred).toBe(1);
        expect(result.full).toMatchObject({ deferred: 0, chunks: 3 });
        expect(result.again).toMatchObject({ embedded: 0, reused: 3 });
        expect(result.newlyEmbedded).toBe(0);
        expect(result.complete).toBe(true);
        expect(result.top).toMatchObject({ line: 3, layer: "sem" });
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }],
  });

  unit("golden sets may carry their provenance in # lines", {
    given: ["a set with a header", () => "# held-out labels are frozen before search\n{\"id\":\"n1\",\"query\":\"q\",\"expect\":[\"a\"],\"split\":\"heldout\"}\n"],
    when: ["parsing", (text) => parseGoldenCases(text)],
    then: ["only the case is read", (cases) => {
      expect(cases).toEqual([{ id: "n1", query: "q", expect: ["a"], kind: "other", split: "heldout" }]);
    }],
  });
});
