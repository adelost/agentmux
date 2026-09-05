import { feature, unit, expect } from "bdd-vitest";
import { formatPaneModel, shouldExpandPane } from "./pane-model-view.mjs";
import { formatContextCell } from "./format.mjs";
import { parseCodexPaneReading } from "../core/codex-status.mjs";

const box = (context = "") => [
  "╭────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.153.4)                 │",
  "│ Model: gpt-6-astra (reasoning max)         │",
  "│ Session: test-session                    │",
  context && `│ Context window: ${context} │`,
  "╰────────────────────────────────────────────╯",
].join("\n");

feature("Codex model visibility with missing or stale status", () => {
  unit("missing and explicit zero context are distinct", {
    when: ["reading a status without usage and a measured zero", () => [
      parseCodexPaneReading(box()),
      parseCodexPaneReading(box("100% left (0 used / 258K)")),
    ]],
    then: ["only the explicit measurement renders zero percent", ([missing, zero]) => {
      expect(missing.context).toBeNull();
      expect(missing.selected.model).toBe("gpt-6-astra");
      expect(formatContextCell(missing.context)).toContain("N/A");
      expect(formatContextCell({ percent: null, tokens: null })).toContain("N/A");
      expect(zero.context).toMatchObject({ percent: 0, tokens: 0 });
      expect(formatContextCell(zero.context)).toContain("0%");
      expect(shouldExpandPane({ status: "idle", context: zero.context })).toBe(true);
    }],
  });

  unit("a status in scrollback cannot override a later selection or supply live usage", {
    when: ["reading a status followed by a conversation and a new footer", () => parseCodexPaneReading(
      `${box("65% left (98.4K used / 258K)")}\n• Later answer\n› Ask Codex to do anything\n  gpt-6-astra xhigh · ~/fixture`,
    )],
    then: ["only the last footer is current", (reading) => {
      expect(reading.selected).toEqual({ model: "gpt-6-astra", effort: "xhigh", source: "codex-footer" });
      expect(reading.context).toBeNull();
    }],
  });

  unit("a startup banner without a session does not establish current status", {
    when: ["reading startup chrome", () => parseCodexPaneReading(
      box("65% left (98.4K used / 258K)").replace("Session: test-session", "Directory: ~/fixture"),
    )],
    then: ["neither a selected model nor usage is invented", (reading) =>
      expect(reading).toEqual({ selected: null, context: null })],
  });

  unit("an unrelated later box cannot renew a status in scrollback", {
    when: ["reading an old status followed by an answer and an unrelated box", () => parseCodexPaneReading(
      `${box("65% left (98.4K used / 258K)")}\n• Later answer\n╭───╮\n│ another menu │\n╰───╯\n› Ask Codex to do anything`,
    )],
    then: ["the original status boundary remains stale", (reading) =>
      expect(reading).toEqual({ selected: null, context: null })],
  });

  unit("a footer selection change invalidates preceding status usage", {
    when: ["reading a new model beneath old status", () => parseCodexPaneReading(
      `${box("65% left (98.4K used / 258K)")}\n› Ask Codex to do anything\n  gpt-other high · ~/fixture`,
    )],
    then: ["model is current but usage is missing", (reading) => {
      expect(reading.selected.model).toBe("gpt-other");
      expect(reading.context).toBeNull();
    }],
  });

  unit("a model mentioned in prose is not a native footer", {
    when: ["reading an answer mentioning a model", () => parseCodexPaneReading(
      "• Previously using gpt-5.6-sol max\n› Ask Codex to do anything\n? for shortcuts",
    )],
    then: ["missing evidence remains absent", (reading) =>
      expect(reading).toEqual({ selected: null, context: null })],
  });

  unit("historical-only and configured-only readings retain their labels", {
    when: ["formatting without context", () => [
      formatPaneModel({ command: "node", modelView: { running: true,
        observed: { model: "gpt-5.6-sol", effort: "max" } } }),
      formatPaneModel({ command: "bash", modelView: { running: false } }),
    ]],
    then: ["no historical model masquerades as a current selection", (labels) =>
      expect(labels).toEqual(["last: gpt-5.6-sol·max", "stopped"])],
  });

  unit("matching live selections coalesce without hiding stopped history", {
    when: ["formatting the same evidence for a live and a stopped process", () =>
      [true, false].map((running) => formatPaneModel({ modelView: {
        running, selected: { model: "gpt-6-astra", effort: "max", source: "codex-footer" },
        observed: { model: "gpt-6-astra", effort: "max" },
      } }))],
    then: ["live rows stay compact and stopped rows retain an explicit historical label", (labels) =>
      expect(labels).toEqual([
        "gpt-6-astra·max [selected]",
        "stopped; gpt-6-astra·max [selected]; last: gpt-6-astra·max",
      ])],
  });
});
