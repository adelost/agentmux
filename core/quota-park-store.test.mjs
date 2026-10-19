import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuotaParkStore } from "./quota-park-store.mjs";

const park = (parkedAt) => ({ agentName: "claw", pane: 1, account: { name: "Claude S", key: "claude:1" }, window: "week",
  resetAt: Date.parse("2026-10-20T04:00:00Z"), parkedAt });

feature("the park store", () => {
  unit("a later park replaces the pane's record, and settling the older one never overwrites it", {
    given: ["claw:1 parked at 19:33Z, then again at 20:06Z", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-park-store-"));
      const store = createQuotaParkStore({ dir });
      const first = store.record(park("2026-10-19T19:33:00.000Z"));
      store.record(park("2026-10-19T20:06:00.000Z"));
      return { dir, store, first };
    }],
    when: ["recovery settles the first park", ({ store, first }) => store.update(first, { state: "resumed" })],
    then: ["the 20:06Z park stays open and is the only record", (returned, { dir, store }) => {
      try {
        expect(returned).toMatchObject({ parkedAt: "2026-10-19T20:06:00.000Z", state: "parked" });
        expect(store.list()).toEqual([expect.objectContaining({ parkedAt: "2026-10-19T20:06:00.000Z", state: "parked" })]);
        expect(store.read("claw", 2)).toBe(null);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }],
  });
});
