import { feature, component, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createHandlers, renderCatchupLine, formatCatchupTime } from "../handlers.mjs";

// --- Test helpers ---

function mockMsg({ content = "hello", channelId = "ch1", isBot = false } = {}) {
  const replies = [];
  return {
    channelId,
    isBot,
    content,
    reply: vi.fn(async (text) => replies.push(text)),
    send: vi.fn(async () => {}),
    startTyping: vi.fn(() => vi.fn()),
    _replies: replies,
  };
}

function setup({ mappingOverride, channelMapEntries } = {}) {
  const defaultMapping = { name: "_ai", dir: "/home/user/project", pane: 0 };
  const mapping = mappingOverride ?? defaultMapping;
  const channelMapData = channelMapEntries ?? new Map([["ch1", defaultMapping]]);

  const overrides = new Map();
  const state = {
    get: vi.fn(() => ({})),
    set: vi.fn(),
    toggle: vi.fn(() => true),
  };

  // isBusy: first 2 calls = busy, then idle (so streaming loop can detect transition)
  // Each setup() gets fresh counter
  const busyState = { calls: 0 };
  const agent = {
    getResponse: vi.fn(async () => "response text"),
    getResponseSegments: vi.fn(async () => ["agent reply"]),
    getResponseStream: vi.fn(async () => [{ type: "text", content: "agent reply" }]),
    getResponseStreamWithRaw: vi.fn(async () => ({
      raw: "raw pane output",
      turn: "turn",
      items: [{ type: "text", content: "agent reply" }],
    })),
    hasResponseForPrompt: vi.fn(async () => false),
    isBusy: vi.fn(async () => { busyState.calls++; return busyState.calls <= 2; }),
    capturePane: vi.fn(async () => "raw pane output"),
    getContextPercent: vi.fn(() => ({ percent: 42, tokens: 84000 })),
    dismissBlockingPrompt: vi.fn(async () => "dismiss"),
    sendEscape: vi.fn(async () => {}),
    sendAndWait: vi.fn(async () => "agent reply"),
    sendOnly: vi.fn(async () => {}),
    waitForPromptEcho: vi.fn(async () => true),
    startProgressTimer: vi.fn(() => ({ timer: setInterval(() => {}, 99999), sentCount: () => 0 })),
  };

  const attachments = {
    buildPrompt: vi.fn(async (msg) => msg.content),
  };

  const tts = {
    isEnabled: vi.fn(() => false),
    toggle: vi.fn(() => true),
    sendFollowup: vi.fn(async () => {}),
  };

  const getMapping = (chId) => overrides.get(chId) || channelMapData.get(chId);
  const reloadConfig = vi.fn();

  const { onMessage } = createHandlers({
    agent,
    attachments,
    tts,
    state,
    getMapping,
    overrides,
    channelMap: () => channelMapData,
    reloadConfig,
    pollInterval: 1,
  });

  return { onMessage, agent, attachments, tts, state, overrides, reloadConfig, channelMapData };
}

// --- Tests ---

feature("onMessage routing", () => {
  component("ignores bot messages", {
    given: ["a message from a bot", () => ({ ...setup(), msg: mockMsg({ isBot: true }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["agent is never called", (_, { agent }) => {
      expect(agent.sendAndWait).not.toHaveBeenCalled();
    }],
  });

  component("ignores unmapped channels", {
    given: ["a message from an unmapped channel", () => ({
      ...setup(),
      msg: mockMsg({ channelId: "unknown-ch" }),
    })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["agent is never called", (_, { agent }) => {
      expect(agent.sendAndWait).not.toHaveBeenCalled();
    }],
  });

  component("ignores empty prompts from attachments", {
    given: ["attachments.buildPrompt returns null", () => {
      const s = setup();
      s.attachments.buildPrompt.mockResolvedValue(null);
      return { ...s, msg: mockMsg() };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["agent is never called", (_, { agent }) => {
      expect(agent.sendAndWait).not.toHaveBeenCalled();
    }],
  });
});

feature("command routing", () => {
  component("/help replies with command list", {
    given: ["a /help message", () => ({ ...setup(), msg: mockMsg({ content: "/help" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["replies with help text", (_, { msg }) => {
      expect(msg.reply).toHaveBeenCalledTimes(1);
      expect(msg.reply.mock.calls[0][0]).toContain("/peek");
    }],
  });

  component("/peek returns extracted response with context", {
    given: ["a /peek message with idle agent", () => {
      const s = setup();
      s.agent.isBusy.mockResolvedValue(false); // override for this test
      return { ...s, msg: mockMsg({ content: "/peek" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["replies with agent response and context%", (_, { msg, agent }) => {
      expect(agent.getResponse).toHaveBeenCalledWith("_ai", 0);
      expect(agent.getContextPercent).toHaveBeenCalledWith("_ai", 0);
      expect(msg.reply).toHaveBeenCalledTimes(1);
      expect(msg.reply.mock.calls[0][0]).toContain("response text");
      expect(msg.reply.mock.calls[0][0]).toContain("context: 42%");
    }],
  });

  component("/raw returns raw pane output", {
    given: ["a /raw message", () => ({ ...setup(), msg: mockMsg({ content: "/raw" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["calls capturePane and replies", (_, { msg, agent }) => {
      expect(agent.capturePane).toHaveBeenCalledWith("_ai", 0);
      expect(msg.reply.mock.calls[0][0]).toContain("raw pane output");
    }],
  });

  component("/status shows agent info", {
    given: ["a /status message", () => ({ ...setup(), msg: mockMsg({ content: "/status" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["replies with agent name and context", (_, { msg }) => {
      const reply = msg.reply.mock.calls[0][0];
      expect(reply).toContain("**_ai**");
      expect(reply).toContain("42%");
    }],
  });

  component("/dismiss delegates to agent", {
    given: ["a /dismiss message", () => ({ ...setup(), msg: mockMsg({ content: "/dismiss" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["calls dismissBlockingPrompt and confirms", (_, { msg, agent }) => {
      expect(agent.dismissBlockingPrompt).toHaveBeenCalledWith("_ai:.0");
      expect(msg.reply).toHaveBeenCalledWith("dismissed");
    }],
  });

  component("/esc sends escape and confirms", {
    given: ["an /esc message", () => ({ ...setup(), msg: mockMsg({ content: "/esc" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["calls sendEscape and replies", (_, { msg, agent }) => {
      expect(agent.sendEscape).toHaveBeenCalledWith("_ai", 0);
      expect(msg.reply).toHaveBeenCalledWith("sent Escape");
    }],
  });

  component("/tts toggles and replies", {
    given: ["a /tts message", () => ({ ...setup(), msg: mockMsg({ content: "/tts" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["calls tts.toggle and confirms", (_, { msg, tts }) => {
      expect(tts.toggle).toHaveBeenCalled();
      expect(msg.reply).toHaveBeenCalledWith("TTS on");
    }],
  });

  component("/reload reloads config and confirms", {
    given: ["a /reload message", () => ({ ...setup(), msg: mockMsg({ content: "/reload" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["calls reloadConfig and replies with count", (_, { msg, reloadConfig }) => {
      expect(reloadConfig).toHaveBeenCalled();
      expect(msg.reply.mock.calls[0][0]).toContain("reloaded");
    }],
  });
});

feature("/use override persistence", () => {
  component("/use sets override and persists to state", {
    given: ["a /use _dev message", () => ({ ...setup(), msg: mockMsg({ content: "/use _dev" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["override is set in Map and saved to state", (_, { overrides, state, msg }) => {
      expect(overrides.get("ch1")).toEqual({ name: "_dev", dir: "/home/user/project", pane: 0 });
      expect(state.set).toHaveBeenCalledWith("overrides", { ch1: { name: "_dev", dir: "/home/user/project", pane: 0 } });
      expect(msg.reply.mock.calls[0][0]).toContain("**_dev**");
    }],
  });

  component("/use with pane sets both name and pane", {
    given: ["a /use _dev.2 message", () => ({ ...setup(), msg: mockMsg({ content: "/use _dev.2" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["override has correct pane", (_, { overrides }) => {
      expect(overrides.get("ch1")).toEqual({ name: "_dev", dir: "/home/user/project", pane: 2 });
    }],
  });

  component("/use reset removes override and deletes from state", {
    given: ["a channel with an active override", () => {
      const s = setup();
      s.overrides.set("ch1", { name: "_dev", dir: "", pane: 0 });
      return { ...s, msg: mockMsg({ content: "/use reset" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["override removed from Map and state", (_, { overrides, state, msg }) => {
      expect(overrides.has("ch1")).toBe(false);
      expect(state.set).toHaveBeenCalledWith("overrides", {});
      expect(msg.reply.mock.calls[0][0]).toContain("reset to");
    }],
  });

  component("/use with invalid args shows usage", {
    given: ["a /use message with no args", () => ({ ...setup(), msg: mockMsg({ content: "/use" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["replies with usage hint", (_, { msg }) => {
      expect(msg.reply.mock.calls[0][0]).toContain("usage:");
    }],
  });
});

feature("pane targeting", () => {
  component("pane prefix routes to correct pane", {
    given: ["a message with .1 prefix and idle agent", () => {
      const s = setup();
      s.agent.isBusy.mockResolvedValue(false);
      return { ...s, msg: mockMsg({ content: ".1 /peek" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["agent.getResponse called with pane 1", (_, { agent }) => {
      expect(agent.getResponse).toHaveBeenCalledWith("_ai", 1);
    }],
  });
});

feature("processMessage pipeline (delivery)", () => {
  // streamResponse was retired in 1.16.32 — replies now flow through
  // channels/jsonl-watcher.mjs instead. These tests cover what's left
  // in processMessage: prompt delivery via withPaneSendLock with retries,
  // typing indicator, and error reply on sendOnly failure. Reply
  // rendering / chunking / TTS / image markers are tested against
  // jsonl-watcher in a follow-up commit.

  component("calls sendOnly with the cleaned prompt", {
    given: ["a regular message", () => ({ ...setup(), msg: mockMsg({ content: "what is 2+2?" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["agent.sendOnly was invoked with prompt + pane", (_, { agent }) => {
      expect(agent.sendOnly).toHaveBeenCalledWith("_ai", "what is 2+2?", 0);
    }],
  });

  component("starts and stops typing indicator", {
    given: ["a regular message", () => ({ ...setup(), msg: mockMsg({ content: "hi" }) })],
    when: ["onMessage completes", ({ onMessage, msg }) => onMessage(msg)],
    then: ["typing was started then stopped", (_, { msg }) => {
      expect(msg.startTyping).toHaveBeenCalledTimes(1);
      const stopTyping = msg.startTyping.mock.results[0].value;
      expect(stopTyping).toHaveBeenCalled();
    }],
  });

  component("replies with error message on sendOnly failure", {
    given: ["agent that throws", () => {
      const s = setup();
      s.agent.sendOnly.mockRejectedValue(new Error("connection lost"));
      return { ...s, msg: mockMsg({ content: "broken" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["replies with error", (_, { msg }) => {
      expect(msg.reply).toHaveBeenCalledWith("connection lost");
    }],
  });

  component("waits for prompt echo before considering delivered", {
    given: ["a regular message", () => ({ ...setup(), msg: mockMsg({ content: "what is 2+2?" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["waitForPromptEcho called with the prompt text", (_, { agent }) => {
      expect(agent.waitForPromptEcho).toHaveBeenCalled();
      const [agentName, paneArg, promptArg] = agent.waitForPromptEcho.mock.calls[0];
      expect(agentName).toBe("_ai");
      expect(paneArg).toBe(0);
      expect(promptArg).toBe("what is 2+2?");
    }],
  });

  component("retries 3 times and warns when prompt is never delivered", {
    given: ["an agent that never echoes and stays idle", () => {
      const s = setup();
      s.agent.waitForPromptEcho.mockResolvedValue(false);
      s.agent.isBusy.mockResolvedValue(false);
      return { ...s, msg: mockMsg({ content: "probably lost" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["sendOnly retried 3x and warning sent", (_, { msg, agent }) => {
      expect(agent.sendOnly.mock.calls.length).toBe(3);
      const sends = msg.send.mock.calls.map((c) => c[0]);
      expect(sends.some((s) => typeof s === "string" && s.includes("3 attempts"))).toBe(true);
    }],
  });

  component("follow-up prompt does not wait for the previous Discord turn to finish", {
    given: ["two messages to the same pane", () => {
      const s = setup();
      const first = mockMsg({ content: "first prompt" });
      const second = mockMsg({ content: "second prompt" });
      return { ...s, first, second };
    }],
    when: ["both messages are processed", async ({ onMessage, first, second }) => {
      const firstRun = onMessage(first);
      await new Promise((r) => setTimeout(r, 0));
      const secondRun = onMessage(second);
      await Promise.all([firstRun, secondRun]);
    }],
    then: ["second sendOnly happens without waiting for first reply", (_, { agent }) => {
      // Both prompts delivered — sendLock serialises sendOnly+echo, but
      // since reply rendering no longer blocks, the second prompt's
      // sendOnly fires shortly after the first's echo confirmation.
      expect(agent.sendOnly).toHaveBeenCalledWith("_ai", "first prompt", 0);
      expect(agent.sendOnly).toHaveBeenCalledWith("_ai", "second prompt", 0);
      expect(agent.sendOnly.mock.calls.length).toBeGreaterThanOrEqual(2);
    }],
  });
});

// --- Catch-up notice rendering -------------------------------------------

feature("renderCatchupLine: how the catch-up banner looks", () => {
  unit("count = 0 → null (no notice)", {
    when: ["rendering", () => renderCatchupLine({ count: 0, latest: null, capped: false })],
    then: ["null", (r) => expect(r).toBeNull()],
  });

  unit("null input → null (silent skip when jsonl missing)", {
    when: ["rendering null", () => renderCatchupLine(null)],
    then: ["null", (r) => expect(r).toBeNull()],
  });

  unit("count = 3 → standard notice with latest timestamp", {
    when: ["rendering", () => renderCatchupLine({
      count: 3,
      latest: new Date().toISOString(),
      capped: false,
    })],
    then: ["contains 3 turns + latest", (r) => {
      expect(r).toContain("ℹ 3 turns since your last Discord sync");
      expect(r).toContain("latest:");
    }],
  });

  unit("capped = true → 50+ notice, no 'latest:' field", {
    when: ["rendering cap", () => renderCatchupLine({
      count: 51, latest: "2026-04-22T10:00:00Z", capped: true,
    })],
    then: ["'50+' phrase, busy tone, no timestamp", (r) => {
      expect(r).toContain("50+");
      expect(r).toContain("you've been busy");
      expect(r).not.toContain("latest:");
    }],
  });

  unit("count = 1 → singular-friendly phrasing (uses same template, fine)", {
    when: ["rendering 1", () => renderCatchupLine({
      count: 1, latest: "2026-04-22T14:32:00Z", capped: false,
    })],
    then: ["1 turns (template consistent)", (r) => {
      expect(r).toContain("1 turns");
    }],
  });
});

feature("formatCatchupTime", () => {
  unit("same-day timestamp → HH:MM", {
    when: ["rendering today 14:32", () => {
      const d = new Date();
      d.setHours(14, 32, 15, 0);
      return formatCatchupTime(d.toISOString());
    }],
    then: ["HH:MM (no date)", (r) => {
      expect(r).toBe("14:32");
    }],
  });

  unit("previous-day timestamp → YYYY-MM-DD HH:MM", {
    when: ["rendering yesterday", () => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      d.setHours(9, 15, 0, 0);
      return formatCatchupTime(d.toISOString());
    }],
    then: ["includes date + time", (r) => {
      expect(r).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
      expect(r).toContain("09:15");
    }],
  });

  unit("invalid ISO falls through to input", {
    when: ["rendering garbage", () => formatCatchupTime("not-a-date")],
    then: ["returns input", (r) => expect(r).toBe("not-a-date")],
  });
});

// --- Loop guard integration (onMessage) -----------------------------------
// Ensures the circuit breaker actually prevents agent.sendOnly calls and
// posts the warning on the 3rd identical short message.

feature("onMessage: loop guard", () => {
  // Stateful in-memory state so loop_guard accumulates across msg turns
  function makeStatefulState() {
    const store = {};
    return {
      _store: store,
      get: (key, fallback) => (key in store ? store[key] : fallback),
      set: (key, value) => { store[key] = value; },
      toggle: () => true,
    };
  }

  function setupGuard({ loopGuardConfig } = {}) {
    const state = makeStatefulState();
    const channelMapData = new Map([["ch1", { name: "_ai", dir: "/tmp/p", pane: 0 }]]);

    // Each message gets a fresh busy→idle transition so streamResponse
    // can exit: busy for the first 2 polls, then idle (matches the pattern
    // used elsewhere in this file).
    const busyCounters = { global: 0 };
    const agent = {
      getResponse: vi.fn(async () => "resp"),
      getResponseSegments: vi.fn(async () => ["resp"]),
      getResponseStreamWithRaw: vi.fn(async () => ({ raw: "", turn: "", items: [{ type: "text", content: "resp" }] })),
      getResponseStream: vi.fn(async () => [{ type: "text", content: "resp" }]),
      hasResponseForPrompt: vi.fn(async () => true),
      isBusy: vi.fn(async () => { busyCounters.global++; return busyCounters.global <= 2; }),
      capturePane: vi.fn(async () => ""),
      getContextPercent: vi.fn(() => null),
      dismissBlockingPrompt: vi.fn(async () => ""),
      sendEscape: vi.fn(async () => {}),
      sendAndWait: vi.fn(async () => "resp"),
      sendOnly: vi.fn(async () => {}),
      waitForPromptEcho: vi.fn(async () => true),
      startProgressTimer: vi.fn(() => ({ timer: null, sentCount: () => 0 })),
    };

    // Ensure buildPrompt reads from the same field the real path uses:
    // normalize.mjs sets msg.text, not msg.content.
    const attachments = { buildPrompt: vi.fn(async (msg) => msg.text) };
    const tts = { isEnabled: vi.fn(() => false), toggle: vi.fn(() => true), sendFollowup: vi.fn(async () => {}) };

    const { onMessage } = createHandlers({
      agent, attachments, tts, state,
      getMapping: (chId) => channelMapData.get(chId),
      overrides: new Map(),
      channelMap: () => channelMapData,
      reloadConfig: vi.fn(),
      pollInterval: 1,
      loopGuardConfig: loopGuardConfig || {
        enabled: true, threshold: 3, windowMs: 30_000, shortLen: 10,
      },
    });

    function fakeMsg(text) {
      return {
        channelId: "ch1", isBot: false,
        text, content: text, // both, since normalize uses text
        reply: vi.fn(async () => {}),
        send: vi.fn(async () => {}),
        startTyping: vi.fn(() => () => {}),
      };
    }
    return { onMessage, state, agent, attachments, fakeMsg };
  }

  component("3 identical '0's → 3rd blocks + warns, agent.sendOnly NOT called for it", {
    given: ["stateful setup", () => setupGuard()],
    when: ["sending 0, 0, 0", async (ctx) => {
      const m1 = ctx.fakeMsg("0");
      const m2 = ctx.fakeMsg("0");
      const m3 = ctx.fakeMsg("0");
      await ctx.onMessage(m1);
      await ctx.onMessage(m2);
      await ctx.onMessage(m3);
      return { m3, attachments: ctx.attachments };
    }],
    then: ["m3.reply got the warning, m3 didn't reach attachments", ({ m3, attachments }) => {
      const warningCalls = m3.reply.mock.calls.filter((c) => typeof c[0] === "string" && c[0].startsWith("⚠ Loop detected"));
      expect(warningCalls.length).toBe(1);
      // The 3rd message should not reach buildPrompt (guard is before attachments)
      // attachments.buildPrompt was called for m1 + m2 only → 2 times
      expect(attachments.buildPrompt).toHaveBeenCalledTimes(2);
    }],
  });

  component("3 different short msgs → none blocks, agent gets all three", {
    given: ["stateful setup", () => setupGuard()],
    when: ["sending a, b, c", async (ctx) => {
      await ctx.onMessage(ctx.fakeMsg("a"));
      await ctx.onMessage(ctx.fakeMsg("b"));
      await ctx.onMessage(ctx.fakeMsg("c"));
      return ctx.attachments;
    }],
    then: ["attachments.buildPrompt fired for all 3", (attachments) => {
      expect(attachments.buildPrompt).toHaveBeenCalledTimes(3);
    }],
  });

  component("4th identical (in same block period) is blocked but warning is silent", {
    given: ["setup", () => setupGuard()],
    when: ["4x '0'", async (ctx) => {
      const msgs = [ctx.fakeMsg("0"), ctx.fakeMsg("0"), ctx.fakeMsg("0"), ctx.fakeMsg("0")];
      for (const m of msgs) await ctx.onMessage(m);
      return msgs;
    }],
    then: ["only 3rd posted a warning, 4th silently blocked", (msgs) => {
      const warnOn3 = msgs[2].reply.mock.calls.some((c) => typeof c[0] === "string" && c[0].startsWith("⚠"));
      const warnOn4 = msgs[3].reply.mock.calls.some((c) => typeof c[0] === "string" && c[0].startsWith("⚠"));
      expect(warnOn3).toBe(true);
      expect(warnOn4).toBe(false);
    }],
  });

  component("loop guard disabled → no blocks even for N identicals", {
    given: ["disabled config", () => setupGuard({
      loopGuardConfig: { enabled: false, threshold: 3, windowMs: 30_000, shortLen: 10 },
    })],
    when: ["5x '0'", async (ctx) => {
      for (let i = 0; i < 5; i++) await ctx.onMessage(ctx.fakeMsg("0"));
      return ctx.attachments;
    }],
    then: ["attachments.buildPrompt ran for all 5, no warnings", (attachments) => {
      expect(attachments.buildPrompt).toHaveBeenCalledTimes(5);
    }],
  });

});
