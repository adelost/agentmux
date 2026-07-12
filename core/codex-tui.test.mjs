import { feature, unit, expect } from "bdd-vitest";
import {
  codexComposerText,
  isCodexTranscriptView,
  prepareCodexIdle,
  verifiedEmptyCodexComposer,
} from "./codex-tui.mjs";

function fakeAgent({ frames, busy = false, busyError = null }) {
  let index = 0;
  const keys = [];
  return {
    keys,
    isBusy: async () => {
      if (busyError) throw busyError;
      return busy;
    },
    capturePane: async () => frames[Math.min(index++, frames.length - 1)],
    sendEscape: async () => keys.push("<esc>"),
    typeLiteral: async (_name, value) => keys.push(value),
  };
}

const noSleep = () => Promise.resolve();

feature("Codex composer truth", () => {
  unit("exact rotating placeholders count as an empty composer", {
    when: ["reading Codex 0.144.x's exact placeholder inventory", () => [
      "Explain this codebase",
      "Summarize recent commits",
      "Implement {feature}",
      "Find and fix a bug in @filename",
      "Write tests for @filename",
      "Improve documentation in @filename",
      "Run /review on my current changes",
      "Use /skills to list available skills",
      "Check recently modified functions for compatibility",
      "How many files have been modified?",
      "Will this algorithm scale well?",
    ].map((hint) => codexComposerText(`\n› ${hint}\n  gpt-5.6-sol xhigh · ~/x\n`))],
    then: ["all normalize to empty", (values) => expect(values).toEqual(Array(11).fill(""))],
  });

  unit("a human draft is preserved as non-empty", {
    when: ["reading a draft", () => verifiedEmptyCodexComposer("\n› please keep this draft\n")],
    then: ["the draft is returned", (value) => expect(value).toBe("please keep this draft")],
  });

  unit("a historical › user cell followed by an assistant bullet is not a draft", {
    when: ["reading replayed transcript without a composer", () => codexComposerText(`
› [from ai:3]
  claim text

• Ingen WIP-kollision.
`)],
    then: ["no composer is reported", (value) => expect(value).toBeNull()],
  });

  unit("the exact post-turn Escape receipt proves neutral state", {
    when: ["reading a composerless idle receipt", () =>
      verifiedEmptyCodexComposer("\nanswer\n\nesc again to edit previous message\n")],
    then: ["it is empty", (value) => expect(value).toBe("")],
  });

  unit("narrow-pane cursor paint inside the idle receipt is tolerated", {
    when: ["reading the observed editoprevious capture", () =>
      verifiedEmptyCodexComposer("\nanswer\n\nesc again to editoprevious message\n")],
    then: ["it is still the exact neutral receipt", (value) => expect(value).toBe("")],
  });

  unit("fresh session's no-previous-message receipt is neutral", {
    when: ["reading Codex's fresh-session Escape response", () =>
      verifiedEmptyCodexComposer("\n• No previous message to edit.\n")],
    then: ["it is empty", (value) => expect(value).toBe("")],
  });

  unit("the full-screen transcript viewer is not mistaken for a historical draft", {
    given: ["Codex transcript chrome", () => `
› old prompt
• old answer
/ T R A N S C R I P T /
q to quit   esc/← to edit prev
`],
    when: ["detecting", (text) => ({ view: isCodexTranscriptView(text), composer: codexComposerText(text) })],
    then: ["view is explicit and composer unknown", (result) => {
      expect(result).toEqual({ view: true, composer: null });
    }],
  });
});

feature("prepareCodexIdle", () => {
  unit("idle empty pane passes without keystrokes", {
    given: ["an empty composer", () => ({ agent: fakeAgent({ frames: ["\n›\n"] }) })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["success and no Escape", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(agent.keys).toEqual([]);
    }],
  });

  unit("composerless completed turn gets one verified reveal", {
    given: ["a missing composer followed by Codex's receipt", () => ({
      agent: fakeAgent({ frames: ["\ncompleted output\n", "\nesc again to edit previous message\n"] }),
    })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["one Escape and success", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(agent.keys).toEqual(["<esc>"]);
    }],
  });

  unit("typing gate waits past a neutral receipt for the real composer", {
    given: ["resume frames where the receipt paints before input", () => ({
      agent: fakeAgent({ frames: [
        "\ncompleted output\n",
        "\n• No previous message to edit.\n",
        "\n• No previous message to edit.\n",
        "\n› Improve documentation in @filename\n",
      ] }),
    })],
    when: ["requiring a visible composer", ({ agent }) => prepareCodexIdle({
      agent, name: "claw", pane: 9, sleep: noSleep, requireVisibleComposer: true,
    })],
    then: ["it waits and succeeds only on the placeholder", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(result.snapshot).toContain("› Improve documentation");
      expect(agent.keys).toEqual(["<esc>"]);
    }],
  });

  unit("typing gate rejects a receipt when input never paints", {
    given: ["a permanently composerless receipt", () => ({
      agent: fakeAgent({ frames: [
        "\ncompleted output\n",
        "\n• No previous message to edit.\n",
      ] }),
    })],
    when: ["requiring a visible composer", ({ agent }) => prepareCodexIdle({
      agent, name: "claw", pane: 9, sleep: noSleep, requireVisibleComposer: true,
    })],
    then: ["it fails instead of typing into another TUI row", (result) => {
      expect(result).toMatchObject({ ok: false, stage: "compose" });
    }],
  });

  unit("transcript viewer is closed with exact q before composer inspection", {
    given: ["transcript view followed by an empty composer", () => ({
      agent: fakeAgent({ frames: [
        "/ T R A N S C R I P T /\nq to quit   esc/← to edit prev\n",
        "\n› Explain this codebase\n",
      ] }),
    })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["q exits and no Escape is sent", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(agent.keys).toEqual(["q"]);
    }],
  });

  unit("busy pane fails before capture or input", {
    given: ["a working pane", () => ({ agent: fakeAgent({ frames: ["\n›\n"], busy: true }) })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["busy failure and no keys", (result, { agent }) => {
      expect(result).toMatchObject({ ok: false, stage: "busy" });
      expect(agent.keys).toEqual([]);
    }],
  });

  unit("busy-safe command may proceed only when an empty composer is visible", {
    given: ["a working pane with an empty composer", () => ({
      agent: fakeAgent({ frames: ["\n› Explain this codebase\n"], busy: true }),
    })],
    when: ["checking for an official during-task slash command", ({ agent }) =>
      prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep, allowBusy: true })],
    then: ["success records that the pane was busy", (result, { agent }) => {
      expect(result).toMatchObject({ ok: true, busy: true });
      expect(agent.keys).toEqual([]);
    }],
  });

  unit("busy-safe command never uses Escape to reveal a missing composer", {
    given: ["a working pane without a visible composer", () => ({
      agent: fakeAgent({ frames: ["\nstreaming output\n"], busy: true }),
    })],
    when: ["checking", ({ agent }) =>
      prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep, allowBusy: true })],
    then: ["it fails without interrupting", (result, { agent }) => {
      expect(result).toMatchObject({ ok: false, stage: "compose" });
      expect(agent.keys).toEqual([]);
    }],
  });

  unit("unknown UI fails closed after one reveal attempt", {
    given: ["no composer and no receipt", () => ({
      agent: fakeAgent({ frames: ["\nunknown\n", "\nstill unknown\n"] }),
    })],
    when: ["checking", ({ agent }) => prepareCodexIdle({ agent, name: "claw", pane: 9, sleep: noSleep })],
    then: ["compose failure", (result, { agent }) => {
      expect(result).toMatchObject({ ok: false, stage: "compose" });
      expect(agent.keys).toEqual(["<esc>"]);
    }],
  });
});
