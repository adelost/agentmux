import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPassage, mergePassageHits, phraseUnits, searchPassages } from "./search-passages.mjs";

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

  component("a question in another inflection finds the answering paragraph", {
    given: ["credits saying who directed the film", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-passages-"));
      writeFileSync(join(dir, "credits.md"), "# Eftertexter\n\nHiromi har regisserat filmen tillsammans med Mattias.\n");
      return { dir, roots: [{ name: "memory", path: dir, semantic: true, exclude: [] }] };
    }],
    when: ["asking who directed it", ({ roots }) => searchPassages("vem regisserade filmen", roots)],
    then: ["regisserade and regisserat count as the same word", (hits, { dir }) => {
      try {
        expect(hits.map(hit => hit.snippet)).toEqual([expect.stringContaining("Hiromi har regisserat filmen")]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  component("one long note cannot fill the overview with its own paragraphs", {
    given: ["a daily note with three matching sections and a reference with one", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-passages-"));
      const section = n => `## Ljudbok ${n}\n\nLjudboken och social kontakt, anteckning ${n}.\n`;
      writeFileSync(join(dir, "daily.md"), `# Dag\n\n${[1, 2, 3].map(section).join("\n")}`);
      writeFileSync(join(dir, "reference.md"), "# Referens\n\nLjudboken och social kontakt i korthet.\n");
      return { dir, roots: [{ name: "memory", path: dir, semantic: true, exclude: [] }] };
    }],
    when: ["searching", ({ roots }) => searchPassages(query, roots)],
    then: ["at most two paragraphs per file and the other file is listed", (hits, { dir }) => {
      try {
        expect(hits.filter(hit => hit.path.endsWith("daily.md"))).toHaveLength(2);
        expect(hits.some(hit => hit.path.endsWith("reference.md"))).toBe(true);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  component("the decisive word alone finds a short entry", {
    given: ["a people index whose entry shares only the name with the question", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-passages-"));
      writeFileSync(join(dir, "people.md"), "# People\n## Familj\n**Axel** — systerson, 1.5 år\n**Petrus** — kollega\n");
      // Question words are common across notes; the name is rare.
      writeFileSync(join(dir, "log.md"), "# Logg\n- Gammal anteckning om annat.\n- Gammal lista.\n- Gammal kod.\n");
      return { dir, roots: [{ name: "memory", path: dir, semantic: true, exclude: [] }] };
    }],
    when: ["asking how old Axel is", ({ roots }) => searchPassages("hur gammal är Axel", roots)],
    then: ["the entry ranks first", (hits, { dir }) => {
      try {
        expect(hits[0].snippet).toBe("**Axel** — systerson, 1.5 år");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  component("a bullet expands with the section it belongs to", {
    given: ["a section whose answer is split over two bullets", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-passages-"));
      writeFileSync(join(dir, "day.md"), "# Dag\n## Rotorsak för 191 commits\n- Siffran var falsk.\n- git status jämför mot indexet.\n## Annat\n- Orelaterat.\n");
      return { dir, roots: [{ name: "memory", path: dir, semantic: true, exclude: [] }] };
    }],
    when: ["expanding the hit on the first bullet", ({ roots }) => {
      const hit = searchPassages("siffran falsk", roots)[0];
      return { hit, view: expandPassage(hit) };
    }],
    then: ["the view shows the heading and the neighbouring bullet, not the next section", ({ hit, view }, { dir }) => {
      try {
        expect(hit.snippet).toBe("- Siffran var falsk.");
        expect(view).toContain("## Rotorsak för 191 commits");
        expect(view).toContain("git status jämför mot indexet");
        expect(view).not.toContain("Orelaterat");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  component("an exact identifier opens the unit about it, not its first passing mention", {
    given: ["a day where a long status bullet names the term before the decision defines it", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-passages-"));
      const path = join(dir, "2026-10-08.md");
      writeFileSync(path, `# Dag\n- ${"Status för prober och loggar. ".repeat(30)}Se GRACE_S.\n- BESLUT: Respiten är 600 s (GRACE_S), inte 60 s.\n- DEP_GRACE_S är något annat.\n`);
      return { dir, path };
    }],
    when: ["expanding the exact hit", ({ path }) => phraseUnits({ path, line: 2, layer: "L1" }, /(?<![\p{L}\p{N}_])GRACE_S(?![\p{L}\p{N}_])/iu)],
    then: ["the defining unit first, the passing mention second, the other identifier never", (units, { dir }) => {
      try {
        expect(units.map((unit) => unit.line)).toEqual([3, 2]);
        expect(expandPassage(units[0])).toContain("Respiten är 600 s (GRACE_S)");
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  component("a name written apart, joined or hyphenated is one name, and a compound contains its head", {
    given: ["a note that writes the tool as two words and the topic as a compound", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-passages-"));
      writeFileSync(join(dir, "day.md"), "# Dag\n- Mattias: Cut kit ska ha noll beroenden på fallskärmshoppning.\n- Kit för kaffe köpt.\n- Cut och klistra i dokumentet.\n");
      return { dir, roots: [{ name: "memory", path: dir, semantic: true, exclude: [] }] };
    }],
    when: ["asking with the joined name and the compound head", ({ roots }) => searchPassages("får cutkit bero på fallskärm", roots)],
    then: ["the note about the tool ranks first", (hits, { dir }) => {
      try {
        expect(hits[0].snippet).toContain("Cut kit ska ha noll beroenden");
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
