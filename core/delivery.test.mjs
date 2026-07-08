// THE delivery contract: verified sends with honest verdicts. These tests
// pin the retry semantics, the busy-queue exception, and the slash/prompt
// routing that every send path (Discord, CLI briefs, auto-compact) rides on.

import { feature, component, unit, expect } from "bdd-vitest";
import { deliverToPane, isSlashCommand, sendPromptVerified } from "./delivery.mjs";
import { readEvents } from "./events.mjs";

// Fake agent with scriptable echo/busy behavior; records interaction order.
function fakeAgent({ echoResults = [], busyResults = [] } = {}) {
  const calls = [];
  let echoIdx = 0, busyIdx = 0;
  return {
    calls,
    dismissBlockingPrompt: async () => { calls.push("dismiss"); return null; },
    sendOnly: async (name, text) => { calls.push(`send:${text.slice(0, 25)}`); },
    sendEnter: async () => { calls.push("enter"); },
    capturePane: async () => { calls.push("capture"); return "❯ \n"; },
    waitForPromptEcho: async () => {
      calls.push("echo");
      return echoResults[Math.min(echoIdx++, echoResults.length - 1)] ?? false;
    },
    isBusy: async () => {
      calls.push("busy");
      return busyResults[Math.min(busyIdx++, busyResults.length - 1)] ?? false;
    },
  };
}

feature("sendPromptVerified", () => {
  component("delivers on first echo, dismissing first", {
    given: ["an agent that echoes immediately", () =>
      fakeAgent({ echoResults: [true] })],
    when: ["sending", async (agent) => ({
      result: await sendPromptVerified(agent, "claw", 1, "kör testerna"),
      agent,
    })],
    then: ["delivered via echo, dismiss ran before send", ({ result, agent }) => {
      expect(result).toEqual({ delivered: true, attempts: 1, via: "echo" });
      expect(agent.calls.slice(0, 2)).toEqual(["dismiss", "send:kör testerna"]);
    }],
  });

  component("busy pane counts as delivered (queued message)", {
    given: ["no echo but a busy pane", () =>
      fakeAgent({ echoResults: [false], busyResults: [true] })],
    when: ["sending", (agent) => sendPromptVerified(agent, "claw", 1, "x")],
    then: ["delivered via busy on attempt 1", (result) =>
      expect(result).toEqual({ delivered: true, attempts: 1, via: "busy" })],
  });

  component("retries then reports honest failure", {
    given: ["an agent that never echoes and never gets busy", () =>
      fakeAgent({ echoResults: [false], busyResults: [false] })],
    when: ["sending with 3 attempts", async (agent) => ({
      result: await sendPromptVerified(agent, "claw", 1, "x", { attempts: 3 }),
      agent,
    })],
    then: ["delivered=false after exactly 3 send attempts", ({ result, agent }) => {
      expect(result).toEqual({ delivered: false, attempts: 3, via: null });
      expect(agent.calls.filter((c) => c.startsWith("send:"))).toHaveLength(3);
    }],
  });

  component("echo on a later attempt still succeeds", {
    given: ["echo fails once then succeeds", () =>
      fakeAgent({ echoResults: [false, true], busyResults: [false] })],
    when: ["sending", (agent) => sendPromptVerified(agent, "claw", 1, "x")],
    then: ["delivered on attempt 2", (result) =>
      expect(result).toEqual({ delivered: true, attempts: 2, via: "echo" })],
  });
});

feature("deliverToPane routing", () => {
  unit("slash commands are recognized; paths are not", {
    given: ["a mix of payloads", () => [
      "/model fable", "/compact", "  /clear", "/gsd-update x",
      "/home/adelost/fil.txt", "vanlig prompt", "10/20 klart",
    ]],
    when: ["classifying", (xs) => xs.map(isSlashCommand)],
    then: ["only real commands match", (r) =>
      expect(r).toEqual([true, true, true, true, false, false, false])],
  });

  component("a /compact routed through deliverToPane uses composer verification", {
    given: ["an agent whose composer consumes the command", () =>
      fakeAgent()],
    when: ["delivering /compact", async (agent) => ({
      result: await deliverToPane(agent, "claw", 1, "/compact",
        { settleMs: 0, sleep: async () => {} }),
      agent,
    })],
    then: ["slash path: capture-verified, no echo polling", ({ result, agent }) => {
      expect(result.delivered).toBe(true);
      expect(agent.calls).toContain("capture");
      expect(agent.calls).not.toContain("echo");
    }],
  });
});

feature("delivery receipts", () => {
  // The global test setup points AMUX_EVENTS_PATH at a per-worker temp
  // ledger, so these receipts never touch the real ~/.agentmux ledger.
  const receiptsFor = (needle) =>
    readEvents({}).filter((e) => e.event === "delivery" && e.detail.includes(needle));

  component("a failed delivery leaves an honest ledger receipt", {
    given: ["an agent that never echoes and never gets busy", () =>
      fakeAgent({ echoResults: [false], busyResults: [false] })],
    when: ["sending a uniquely tagged prompt that fails", async (agent) => {
      const tag = `receipt-fail-${Math.random().toString(36).slice(2)}`;
      await sendPromptVerified(agent, "claw", 1, tag, { attempts: 2 });
      return receiptsFor(tag);
    }],
    then: ["one receipt: delivered=false with the attempt count", (receipts) => {
      expect(receipts).toHaveLength(1);
      expect(receipts[0].delivered).toBe(false);
      expect(receipts[0].kind).toBe("prompt");
      expect(receipts[0].attempts).toBe(2);
    }],
  });

  component("a delivered slash command is receipted too", {
    given: ["an agent whose composer consumes the command", () => fakeAgent()],
    when: ["delivering /compact", async (agent) => {
      await deliverToPane(agent, "claw", 2, "/compact", { settleMs: 0, sleep: async () => {} });
      return readEvents({}).filter((e) =>
        e.event === "delivery" && e.kind === "slash" && e.session === "claw" && e.pane === 2);
    }],
    then: ["receipt says delivered slash", (receipts) => {
      expect(receipts.length).toBeGreaterThanOrEqual(1);
      expect(receipts.at(-1).delivered).toBe(true);
    }],
  });
});
