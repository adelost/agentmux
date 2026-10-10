import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, rankUnits, reindex, semanticModel } from "./search-semantic.mjs";
import { createLiveIndex } from "./search-live-index.mjs";
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

  component("a note edited after the nightly build is searchable without a reindex", {
    given: ["an index built before today's note grew", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-live-root-"));
      const dir = mkdtempSync(join(tmpdir(), "amux-live-index-"));
      const path = join(root, "2026-10-10.md");
      writeFileSync(path, "# 2026-10-10\n- Axel fyller år.\n- Bumbi-filmen klar.\n");
      const roots = [{ name: "memory", path: root, semantic: true, exclude: [], weight: 3 }];
      await reindex(roots, { dir, embed: fakeEmbed, model: semanticModel("Xenova/multilingual-e5-small") });
      writeFileSync(path, "# 2026-10-10\n- Axel fyller år.\n- Bumbi-filmen klar.\n- Ny kassör vald i klubben.\n");
      return { root, dir, roots, path };
    }],
    when: ["the daemon's live index refreshes and ranks", async ({ dir, roots }) => {
      const embedded = [];
      const live = createLiveIndex({ dir, scanEveryMs: 0, embed: async (texts, kind) => { embedded.push(...texts); return fakeEmbed(texts, kind); } });
      await live.refresh(roots);
      const [query] = await fakeEmbed(["vem är kassör"]);
      return { embedded, top: live.rank(query, 1)[0] };
    }],
    then: ["only the new bullet is embedded and it ranks with its current offsets", ({ embedded, top }, { root, dir, path }) => {
      try {
        expect(embedded).toEqual([expect.stringContaining("Ny kassör vald i klubben.")]);
        expect(top).toMatchObject({ path, line: 4, indexedSize: statSync(path).size });
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }],
  });

  unit("golden sets may carry their provenance in # lines", {
    given: ["a set with a header", () => "# held-out labels are frozen before search\n{\"id\":\"n1\",\"query\":\"q\",\"expect\":[\"a\"],\"split\":\"heldout\",\"asOf\":\"2026-10-10\"}\n"],
    when: ["parsing", (text) => parseGoldenCases(text)],
    then: ["only the case is read, with the day it was written", (cases) => {
      expect(cases).toEqual([{ id: "n1", query: "q", expect: ["a"], kind: "other", split: "heldout", asOf: "2026-10-10" }]);
    }],
  });
});
