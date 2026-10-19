import { feature, component, expect } from "bdd-vitest";
import { composerAgent } from "../test/fixtures/composer-agent.mjs";
import { withdrawDraft } from "./draft-withdrawal.mjs";

// lsrc:0 2026-10-19 (claw:2): a cancelled delivery either clears its own draft or submits it, and text amux cannot
// prove is its own is never cleared (claude-composer-guards.mjs, 2026-09-28). The pane is the shared fixture, so
// these tests assert what a person would see: the composer text and the keys that reached the pane.
const TEXT = "[from claw:0] Continue the task you were on.\nThe weekly limit has reset.";
const withdraw = async (paneOptions, jobText = TEXT) => {
  const { agent, pane } = composerAgent(paneOptions);
  const result = await withdrawDraft({ agent, job: { agentName: "claw", pane: 2, text: jobText }, wait: async () => {} });
  return { ...result, pane };
};

feature("a cancelled delivery clears only the draft it can prove is its own", () => {
  component("its own text on an idle Claude pane is cleared with two Escapes", {
    when: ["withdrawing the draft", () => withdraw({ composer: TEXT })],
    then: ["the composer is empty and no key did harm", ({ outcome, pane }) => {
      expect(outcome).toBe("cleared");
      expect(pane.composer).toBe("");
      expect(pane.keys).toEqual(["Escape", "Escape"]);
      expect(pane.rewindOpened).toBe(false);
      expect(pane.enters).toBe(0);
    }],
  });

  component("its own text wrapped over other rows still counts as its own", {
    when: ["withdrawing a draft that Claude wrapped at every space", () =>
      withdraw({ composer: TEXT.replace(/ /gu, "\n") })],
    then: ["it is cleared", ({ outcome, pane }) => {
      expect(outcome).toBe("cleared");
      expect(pane.composer).toBe("");
    }],
  });

  component("a model command is compared as typed, not as queued", {
    when: ["withdrawing /model opus after Claude was sent the pinned id", () =>
      withdraw({ composer: "/model claude-opus-5-5" }, "/model opus")],
    then: ["it is cleared", ({ outcome, pane }) => {
      expect(outcome).toBe("cleared");
      expect(pane.composer).toBe("");
    }],
  });

  component("Codex is cleared through its clear-line keys, one pass for each row of the text", {
    when: ["withdrawing its own two-row text from an idle Codex pane", () => withdraw({ dialect: "codex", composer: TEXT })],
    then: ["the composer is empty and no Escape was sent on its own", ({ outcome, pane }) => {
      expect(outcome).toBe("cleared");
      expect(pane.composer).toBe("");
      expect(pane.keys).toEqual(["clear-line", "clear-line"]);
    }],
  });

  for (const [name, composer] of [
    ["a person's words added after it", `${TEXT} And buy milk on the way.`],
    ["a collapsed paste", "[Pasted text #1 +12 lines]"],
    ["another message", "A different message that amux never typed."],
  ]) {
    component(`${name} is never cleared`, {
      when: ["withdrawing while the composer holds it", () => withdraw({ composer })],
      then: ["the composer is untouched and no key was sent", ({ outcome, pane }) => {
        expect(outcome).toBe("foreign");
        expect(pane.composer).toBe(composer);
        expect(pane.keys).toEqual([]);
      }],
    });
  }

  component("an empty composer gets no key, since two Escapes there open Claude's rewind menu", {
    when: ["withdrawing after the text was already erased", () => withdraw({ composer: "" })],
    then: ["nothing is left and no key was sent", ({ outcome, pane }) => {
      expect(outcome).toBe("absent");
      expect(pane.keys).toEqual([]);
      expect(pane.rewindOpened).toBe(false);
    }],
  });

  component("a busy pane gets no key, since Escape there interrupts the turn", {
    when: ["withdrawing while the turn runs", () => withdraw({ composer: TEXT, busy: true })],
    then: ["the draft stays and the withdrawal waits", ({ outcome, detail, pane }) => {
      expect(outcome).toBe("unobservable");
      expect(detail).toMatch(/busy/u);
      expect(pane.composer).toBe(TEXT);
      expect(pane.keys).toEqual([]);
      expect(pane.interrupted).toBe(false);
    }],
  });

  component("a paste Claude still holds is left alone", {
    when: ["withdrawing while Claude shows Pasting…", () => withdraw({ composer: "", pasting: true })],
    then: ["the withdrawal waits and no key was sent", ({ outcome, pane }) => {
      expect(outcome).toBe("unobservable");
      expect(pane.keys).toEqual([]);
    }],
  });

  component("a composer that is not on the screen is left alone", {
    when: ["withdrawing while a dialog covers the composer", () => withdraw({ composer: TEXT, hidden: true })],
    then: ["the withdrawal waits and no key was sent", ({ outcome, pane }) => {
      expect(outcome).toBe("unobservable");
      expect(pane.keys).toEqual([]);
    }],
  });

  component("a failed capture is reported instead of guessed", {
    when: ["withdrawing when tmux cannot capture the pane", async () => {
      const { agent, pane } = composerAgent({ composer: TEXT });
      pane.captureFails = true;
      return { ...(await withdrawDraft({ agent, job: { agentName: "claw", pane: 2, text: TEXT }, wait: async () => {} })), pane };
    }],
    then: ["the withdrawal waits and says why", ({ outcome, detail, pane }) => {
      expect(outcome).toBe("unobservable");
      expect(detail).toMatch(/capture failed/u);
      expect(pane.keys).toEqual([]);
    }],
  });

  component("keys that leave the text in place are not reported as cleared", {
    when: ["withdrawing while the pane ignores the clear keys", async () => {
      const { agent, pane } = composerAgent({ composer: TEXT });
      pane.keysIgnored = true;
      return { ...(await withdrawDraft({ agent, job: { agentName: "claw", pane: 2, text: TEXT }, wait: async () => {} })), pane };
    }],
    then: ["the withdrawal waits for another look", ({ outcome, pane }) => {
      expect(outcome).toBe("unobservable");
      expect(pane.composer).toBe(TEXT);
    }],
  });

  component("an engine whose composer amux does not read is left alone", {
    when: ["withdrawing from a Kimi pane", () => withdraw({ dialect: "kimi", composer: TEXT })],
    then: ["no key was sent and the text is untouched", ({ outcome, pane }) => {
      expect(outcome).toBe("unreadable");
      expect(pane.composer).toBe(TEXT);
      expect(pane.keys).toEqual([]);
    }],
  });
});
