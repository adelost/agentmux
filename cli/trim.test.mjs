import { expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdTrim } from "./trim.mjs";

feature("amux trim command", () => {
  unit("prints one truthful empty receipt without requiring a bridge", {
    given: ["an isolated home with no provider sessions", () => mkdtempSync(join(tmpdir(), "amux-trim-cli-"))],
    when: ["running the manual dry command", (home) => {
      const lines = [];
      const original = console.log;
      console.log = (line) => lines.push(String(line));
      try { return { home, lines, result: cmdTrim({ dry: true }, { env: { HOME: home } }) }; }
      finally { console.log = original; }
    }],
    then: ["the receipt distinguishes zero candidates from failure", ({ home, lines, result }) => {
      try {
        expect(result).toMatchObject({ scanned: 0, oversized: 0, wouldTrim: 0, protected: 0 });
        expect(lines).toEqual(["trim: trimmed 0/0 oversized, reclaim 0.0MB"]);
      } finally { rmSync(home, { recursive: true, force: true }); }
    }],
  });
});
