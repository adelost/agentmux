import { expect, feature, unit } from "bdd-vitest";
import { swedishStem } from "./swedish-stem.mjs";

feature("Swedish Snowball stemming", () => {
  unit("inflections of one word share a stem", {
    when: ["stemming verb, noun and plural forms", () => ({
      directed: ["regisserade", "regisserat"].map(swedishStem),
      scaled: ["skala", "skalas"].map(swedishStem),
      plural: ["hopparna", "hoppare"].map(swedishStem),
    })],
    then: ["each group collapses to one stem", ({ directed, scaled, plural }) => {
      expect(new Set(directed).size).toBe(1);
      expect(new Set(scaled).size).toBe(1);
      expect(new Set(plural).size).toBe(1);
    }],
  });

  unit("matches the published algorithm on reference words", {
    when: ["stemming words with known Snowball output", () =>
      ["klockorna", "jaktens", "knappar", "vänligt", "snabbt", "inloggning"].map(swedishStem)],
    then: ["suffixes are only removed from R1", stems =>
      expect(stems).toEqual(["klock", "jakt", "knapp", "vän", "snabbt", "inloggning"])],
  });
});
