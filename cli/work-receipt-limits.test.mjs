import { expect, feature, unit } from "bdd-vitest";
import { assertReceiptFieldLengths } from "./work.mjs";

const chars = (count) => "x".repeat(count);
const rejects = (fields) => {
  try { assertReceiptFieldLengths(fields); return null; }
  catch (error) { return error.message; }
};

feature("Booking a delivery whose summary is too long for the board", () => {
  unit("names the flag, its length and the limit instead of blaming the receipt", {
    given: ["a summary one character past the board's 2000-char bound", () => ({ summary: chars(2_001) })],
    when: ["the receipt is checked before it is sent", (fields) => rejects(fields)],
    then: ["the message points at --summary and the number that broke it", (message) => {
      expect(message).toContain("--summary is 2001 chars");
      expect(message).toContain("2000");
    }],
  });

  unit("holds a summary exactly at the bound, because the board does", {
    given: ["a summary of exactly 2000 chars", () => ({ summary: chars(2_000) })],
    when: ["the receipt is checked", (fields) => rejects(fields)],
    then: ["nothing is rejected", (message) => expect(message).toBeNull()],
  });

  unit("catches an over-long --tests proof, the field agents paste output into", {
    given: ["a tests label past the 500-char evidence bound", () => ({ tests: chars(501) })],
    when: ["the receipt is checked", (fields) => rejects(fields)],
    then: ["the tests flag is named, not the summary", (message) => {
      expect(message).toContain("--tests is 501 chars");
      expect(message).not.toContain("--summary");
    }],
  });

  unit("ignores flags the caller never passed", {
    given: ["only tests supplied, deploy and live omitted", () => ({ tests: "unit suite green" })],
    when: ["the receipt is checked", (fields) => rejects(fields)],
    then: ["absent fields are not treated as empty violations", (message) => expect(message).toBeNull()],
  });

  unit("measures the trimmed text, matching the board's own cleanText", {
    given: ["a 2000-char summary wrapped in whitespace", () => ({ summary: `\n  ${chars(2_000)}  \n` })],
    when: ["the receipt is checked", (fields) => rejects(fields)],
    then: ["padding does not push it over the bound", (message) => expect(message).toBeNull()],
  });
});
