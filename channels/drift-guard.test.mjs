// Only Claude Code's literal notification placeholder is suppressed;
// short real acknowledgements still mirror (#api-1 2026-07-08).
import { feature, unit, expect as bddExpect } from "bdd-vitest";
import { isHarnessPlaceholder } from "../core/reply-forwarder.mjs";

feature("isHarnessPlaceholder", () => {
  unit("matches only Claude Code's literal placeholder", {
    given: ["assorted replies", () => [
      "No response requested.",
      "no response requested",
      "  No response requested.  ",
      "Kvitterat.",
      "ok",
      "No response requested. Men jag har en fråga:",
    ]],
    when: ["classifying", (xs) => xs.map(isHarnessPlaceholder)],
    then: ["exactly the three placeholder variants match", (r) =>
      bddExpect(r).toEqual([true, true, true, false, false, false])],
  });
});
