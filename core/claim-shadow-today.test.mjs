import { expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimShadowTodayLine } from "./claim-shadow-today.mjs";

feature("daily shadow measurements are actual replies, not sampled or repeated flags", () => {
  unit("counts unique UTC-day holds and excludes name-only warnings and old/future decisions", {
    given: ["a private decision log", () => {
      const dir = mkdtempSync(join(tmpdir(), "claim-shadow-today-")), path = join(dir, "decisions.jsonl");
      const base = { at: "2026-10-27T01:00:00Z", event: "shadow", verdict: "hold", paneKey: "claw:5", turnId: "one" };
      writeFileSync(path, [base, base, { ...base, turnId: "two" }, { ...base, verdict: "pass", names: { verdict: "hold" }, turnId: "name" },
        { ...base, at: "2026-10-26T23:59:59Z", turnId: "yesterday" }, { ...base, at: "2026-10-27T23:59:59Z", turnId: "future" },
        { ...base, event: "checked", turnId: "enforced" }].map(row => JSON.stringify(row)).join("\n"));
      return { dir, path, now: Date.parse("2026-10-27T12:00:00Z") };
    }],
    when: ["reading the one-line measurement", f => ({ ...f, line: claimShadowTodayLine(f) })],
    then: ["only two actual shadow replies count", f => {
      expect(f.line).toBe("Skuggmätning idag (UTC): 2 flaggade svar");
      writeFileSync(f.path, "{partial"); expect(claimShadowTodayLine(f)).toContain("minst 0");
      expect(claimShadowTodayLine({ ...f, path: join(f.dir, "absent") })).toContain("inga mätdata");
    }],
    cleanup: f => rmSync(f.dir, { recursive: true, force: true }),
  });
});
