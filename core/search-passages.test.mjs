import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPassage, mergePassageHits, searchPassages } from "./search-passages.mjs";

const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "amux-passages-"));
  const path = join(dir, "observations.md");
  writeFileSync(path, "# Observationer\n\nLjudboken hjälpte vid städningen. Social kontakt gjorde vardagen lättare.\n");
  return { dir, path, roots: [{ name: "memory", path: dir, semantic: true, exclude: [] }] };
};
const query = "Vad hjälpte mig med ljudboken och social kontakt?";

feature("fresh original passage retrieval", () => {
  component("search reads current text and refuses an old expansion after edits", {
    given: ["a source containing the first answer", fixture],
    when: ["editing the source between search and expansion", ({ path, roots }) => {
      const [before] = searchPassages(query, roots);
      const initial = expandPassage(before);
      writeFileSync(path, "# Observationer\n\nLjudboken hjälpte inte längre. Social kontakt var däremot fortfarande hjälpsam.\n");
      const stale = expandPassage(before);
      const [after] = searchPassages(query, roots);
      return { initial, stale, fresh: expandPassage(after) };
    }],
    then: ["old content cannot be replayed while a new search finds the correction", (result, { dir }) => {
      try {
        expect(result.initial).toContain("Ljudboken hjälpte vid städningen");
        expect(result.stale).toContain("Source changed since search");
        expect(result.stale).not.toContain("hjälpte vid städningen");
        expect(result.fresh).toContain("Ljudboken hjälpte inte längre");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  component("deleted and forged source references fail closed", {
    given: ["a retrievable original", fixture],
    when: ["changing the stored hash then removing the source", ({ path, roots }) => {
      const [hit] = searchPassages(query, roots);
      const forged = expandPassage({ ...hit, passage: { ...hit.passage, sha256: "0".repeat(64) } });
      rmSync(path);
      return { forged, deleted: expandPassage(hit) };
    }],
    then: ["neither result pretends to be the answer", ({ forged, deleted }, { dir }) => {
      try {
        expect(forged).toContain("Source changed");
        expect(deleted).toContain("Passage unavailable");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  component("scope exclusions cannot be bypassed by paragraph ranking", {
    given: ["two matching files, one excluded", () => {
      const value = fixture();
      writeFileSync(join(value.dir, "private.md"), "# Ljudboken\n\nSocial kontakt är en privat källa som inte ska matcha.\n");
      return value;
    }],
    when: ["excluding one path and then the other root", ({ path, roots }) => ({
      selected: searchPassages(query, roots, { excludePath: candidate => candidate !== path }),
      disabled: searchPassages(query, roots.map(root => ({ ...root, semantic: false }))),
      unknown: searchPassages("unrelatedzzq impossiblezzq", roots),
    })],
    then: ["only permitted matching originals are returned", ({ selected, disabled, unknown }, { dir, path }) => {
      try {
        expect(selected.length).toBeGreaterThan(0);
        expect(selected.every(hit => hit.path === path)).toBe(true);
        expect(disabled).toEqual([]);
        expect(unknown).toEqual([]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  unit("exact evidence remains first and history stays reachable", {
    given: ["an exact receipt, broad history and a relevant paragraph", () => ({
      original: [{ path: "/receipt.jsonl", line: 8, layer: "L1" }, { path: "/history.jsonl", line: 6, layer: "L2" }],
      passages: [{ path: "/answer.md", line: 3, layer: "passage" }],
    })],
    when: ["combining layers", ({ original, passages }) => mergePassageHits(original, passages)],
    then: ["all evidence remains, in explicit priority order", hits => {
      expect(hits.map(hit => hit.path)).toEqual(["/receipt.jsonl", "/answer.md", "/history.jsonl"]);
    }],
  });
});
