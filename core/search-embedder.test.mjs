import { expect, feature, unit } from "bdd-vitest";
import { warmStart } from "./search-embedder.mjs";

feature("search daemon warm start", () => {
  unit("the roots that started the daemon are parsed and scanned before the first question", {
    given: ["the roots passed at start and recorders for the cache and overlay", () => ({
      roots: [{ name: "memory", path: "/m", semantic: true, exclude: [] }], calls: [], segments: new Map(),
    })],
    when: ["warming", ({ roots, calls, segments }) => ({
      warmed: warmStart(JSON.stringify(roots), { segments, live: { refresh: (value) => calls.push(["refresh", value]) },
        search: (query, value, options) => calls.push(["search", value, options.cache === segments]) }),
      without: warmStart(undefined, { segments, live: { refresh: () => calls.push(["unexpected"]) }, search: () => calls.push(["unexpected"]) }),
    })],
    then: ["the passage cache is filled and the overlay scanned; no roots means no work", ({ warmed, without }, { roots, calls }) => {
      expect(warmed).toBe(true);
      expect(without).toBe(false);
      expect(calls).toEqual([["search", roots, true], ["refresh", roots]]);
    }],
  });
});
