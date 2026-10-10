import { expect, feature, unit } from "bdd-vitest";
import { markdownUnits } from "./search-units.mjs";

const people = [
  "# People",
  "## Familj <!-- entry-check: none -->",
  "**Axel** — systerson, 1.5 år",
  "**Amanda W** — bekant via dansen",
  "- Senast: musikkväll hos henne",
  "  fortsättning på samma punkt",
  "",
  "Ett vanligt stycke",
  "som fortsätter här.",
  "## Övriga",
  "- Ny punkt",
].join("\n");

feature("item-sized retrieval units", () => {
  unit("each person entry is its own unit and its bullets carry the entry name", {
    given: ["a people index with entries and sub-bullets", () => people],
    when: ["splitting into units", (text) => markdownUnits(text)],
    then: ["short entries stand alone and bullets know their subject", (units) => {
      expect(units.map((u) => u.text)).toEqual([
        "**Axel** — systerson, 1.5 år",
        "**Amanda W** — bekant via dansen",
        "- Senast: musikkväll hos henne\n  fortsättning på samma punkt",
        "Ett vanligt stycke\nsom fortsätter här.",
        "- Ny punkt",
      ]);
      expect(units[2]).toMatchObject({ entry: "Amanda W", headings: ["People", "Familj"], line: 5 });
    }],
  });

  unit("offsets point at the exact source text and sections end at the next heading", {
    given: ["the same document", () => people],
    when: ["splitting into units", (text) => ({ text, units: markdownUnits(text) })],
    then: ["every unit is a verbatim slice inside its section", ({ text, units }) => {
      for (const u of units) {
        expect(text.slice(u.start, u.start + u.length)).toBe(u.text);
        expect(u.section.start).toBeLessThanOrEqual(u.start);
        expect(u.section.end).toBeGreaterThanOrEqual(u.start + u.length);
      }
      expect(text.slice(units[0].section.start, units[0].section.end)).toMatch(/^## Familj[\s\S]*fortsätter här\.\n$/u);
    }],
  });
});
