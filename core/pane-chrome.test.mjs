// The chrome stripper is the last line of defence against UI rendering
// leaking into Discord replies and TTS. The fable case is the regression
// that motivated sharing ONE copy: a model family added to one private
// copy but not the other leaked footers for months.

import { feature, unit, expect } from "bdd-vitest";
import { stripPaneChrome } from "./pane-chrome.mjs";

feature("stripPaneChrome", () => {
  unit("drops fable footers, bare and prefixed (the missed family)", {
    given: ["a reply with fable chrome lines", () => [
      "Här är svaret på din fråga.",
      "fable-5 · context: 51% (508k)",
      "claude-fable-5[1m] │ ▓▓░░ 92%",
      "Fable 5 (1M context) │ 0 █░░░ 14%",
    ].join("\n")],
    when: ["stripping", (text) => stripPaneChrome(text)],
    then: ["only the speech survives", (out) =>
      expect(out).toBe("Här är svaret på din fråga.")],
  });

  unit("drops classic opus footers and progress bars", {
    given: ["a reply with opus chrome", () => [
      "Klart!",
      "Opus 4.7 (1M context) │ 0 █░░░ 14%",
      "▓▓▓▓░░░░ 42%",
      "✻ Pondering…",
    ].join("\n")],
    when: ["stripping", (text) => stripPaneChrome(text)],
    then: ["only speech survives", (out) => expect(out).toBe("Klart!")],
  });

  unit("keeps real prose that merely mentions a model name", {
    given: ["a sentence about fable", () =>
      "Jag bytte till fable-modellen eftersom den är snabbare."],
    when: ["stripping", (text) => stripPaneChrome(text)],
    then: ["untouched", (out) =>
      expect(out).toBe("Jag bytte till fable-modellen eftersom den är snabbare.")],
  });
});
