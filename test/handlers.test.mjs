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

feature("processMessage pipeline (streaming)", () => {
  component("sends prompt and streams response", {
    given: ["a regular message", () => ({ ...setup(), msg: mockMsg({ content: "what is 2+2?" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["agent.sendOnly called and stream sent", (_, { msg, agent }) => {
      expect(agent.sendOnly).toHaveBeenCalledWith("_ai", "what is 2+2?", 0);
      expect(msg.send).toHaveBeenCalled();
      expect(msg.send.mock.calls.some((c) => c[0]?.includes("agent reply"))).toBe(true);
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

  component("dedupes already-sent items", {
    given: ["stream that returns same item twice", () => {
      const s = setup();
      s.agent.getResponseStream.mockResolvedValue([
        { type: "text", content: "hello world" },
      ]);
      return { ...s, msg: mockMsg({ content: "hi" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["text sent only once across multiple polls", (_, { msg }) => {
      const sends = msg.send.mock.calls.filter((c) => c[0]?.includes("hello world"));
      expect(sends.length).toBe(1);
    }],
  });

  component("formats tool calls with italics", {
    given: ["stream with tool call", () => {
      const s = setup();
      s.agent.getResponseStream.mockResolvedValue([
        { type: "tool", content: "Read file.ts" },
      ]);
      return { ...s, msg: mockMsg({ content: "hi" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["tool wrapped in asterisks", (_, { msg }) => {
      expect(msg.send.mock.calls.some((c) => c[0] === "*Read file.ts*")).toBe(true);
    }],
  });

  component("splits long items into Discord-size chunks", {
    given: ["stream with a 3000-char text item", () => {
      const s = setup();
      const longText = "x".repeat(3000);
      s.agent.getResponseStream.mockResolvedValue([
        { type: "text", content: longText },
      ]);
      return { ...s, msg: mockMsg({ content: "hi" }), longText };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["sent as multiple chunks, each under 2000 chars", (_, { msg, longText }) => {
      const sendCalls = msg.send.mock.calls.map((c) => c[0]);
      // Exclude the context line
      const textChunks = sendCalls.filter((c) => !c.startsWith("_context"));
      expect(textChunks.length).toBeGreaterThan(1);
      for (const chunk of textChunks) {
        expect(chunk.length).toBeLessThanOrEqual(2000);
      }
      // Reassembled content is the original text
      expect(textChunks.join("")).toBe(longText);
    }],
  });

  component("calls tts.sendFollowup when tts is enabled", {
    given: ["a message with tts enabled", () => {
      const s = setup();
      s.tts.isEnabled.mockReturnValue(true);
      s.agent.getResponseStream.mockResolvedValue([
        { type: "tool", content: "Read file.ts" },
        { type: "text", content: "here it is" },
      ]);
      return { ...s, msg: mockMsg({ content: "hi" }) };
    }],
    when: ["onMessage completes", ({ onMessage, msg }) => onMessage(msg)],
    then: ["sendFollowup called with text only (no tool calls)", (_, { tts }) => {
      expect(tts.sendFollowup).toHaveBeenCalledTimes(1);
      const spokenText = tts.sendFollowup.mock.calls[0][1];
      expect(spokenText).toBe("here it is");
      expect(spokenText).not.toContain("Read file.ts");
    }],
  });

  component("does not call tts.sendFollowup when tts is disabled", {
    given: ["a message with tts disabled", () => {
      const s = setup();
      s.tts.isEnabled.mockReturnValue(false);
      return { ...s, msg: mockMsg({ content: "hi" }) };
    }],
    when: ["onMessage completes", ({ onMessage, msg }) => onMessage(msg)],
    then: ["sendFollowup never called", (_, { tts }) => {
      expect(tts.sendFollowup).not.toHaveBeenCalled();
    }],
  });

  component("does not call tts.sendFollowup when response has no text", {
    given: ["tts enabled but tool-only response", () => {
      const s = setup();
      s.tts.isEnabled.mockReturnValue(true);
      s.agent.getResponseStream.mockResolvedValue([
        { type: "tool", content: "Bash ls" },
      ]);
      return { ...s, msg: mockMsg({ content: "hi" }) };
    }],
    when: ["onMessage completes", ({ onMessage, msg }) => onMessage(msg)],
    then: ["sendFollowup skipped since no text to speak", (_, { tts }) => {
      expect(tts.sendFollowup).not.toHaveBeenCalled();
    }],
  });

  component("waits for prompt echo before polling for busy", {
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
      // hasResponseForPrompt returns true so polling loop exits quickly
      s.agent.hasResponseForPrompt.mockResolvedValue(true);
      return { ...s, msg: mockMsg({ content: "probably lost" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["retries send 3 times, warns user, still extracts", (_, { msg, agent }) => {
      // sendOnly called 3 times (retry loop)
      expect(agent.sendOnly.mock.calls.length).toBe(3);
      // Warning sent after 3 failed attempts
      const sends = msg.send.mock.calls.map((c) => c[0]);
      expect(sends.some((s) => typeof s === "string" && s.includes("3 attempts"))).toBe(true);
      // Extract still runs
      expect(agent.getResponseStream).toHaveBeenCalled();
    }],
  });

  component("still polls isBusy when echo timeout fires", {
    given: ["echo timeout", () => {
      const s = setup();
      s.agent.waitForPromptEcho.mockResolvedValue(false);
      return { ...s, msg: mockMsg({ content: "timeout case" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["isBusy is polled (continues after warning)", (_, { agent }) => {
      expect(agent.isBusy).toHaveBeenCalled();
    }],
  });

  component("queued follow-up prompt gets its own response stream", {
    given: ["two messages to the same busy pane", () => {
      const s = setup();
      const first = mockMsg({ content: "first prompt" });
      const second = mockMsg({ content: "second prompt" });

      let releaseFirstBusy;
      const firstBusy = new Promise((resolve) => { releaseFirstBusy = resolve; });
      let firstBusyCalls = 0;

      s.agent.isBusy.mockImplementation(async (_, __, promptText) => {
        if (promptText === "first prompt") {
          firstBusyCalls++;
          if (firstBusyCalls === 1) return firstBusy;
          return false;
        }
        if (promptText === "second prompt") return false;
        return false;
      });
      s.agent.hasResponseForPrompt.mockImplementation(async (_, __, promptText) =>
        promptText === "second prompt");
      s.agent.getResponseStream.mockImplementation(async (_, __, promptText) => [{
        type: "text",
        content: `reply for ${promptText}`,
      }]);

      return { ...s, first, second, releaseFirstBusy };
    }],
    when: ["both messages are processed", async ({ onMessage, first, second, releaseFirstBusy }) => {
      const firstRun = onMessage(first);
      await new Promise((r) => setTimeout(r, 0));
      const secondRun = onMessage(second);
      releaseFirstBusy(true);
      await Promise.all([firstRun, secondRun]);
    }],
    then: ["the queued message is also streamed back to Discord", (_, { first, second, agent }) => {
      expect(agent.sendOnly).toHaveBeenCalledWith("_ai", "first prompt", 0);
      expect(agent.sendOnly).toHaveBeenCalledWith("_ai", "second prompt", 0);
      expect(first.send.mock.calls.some((c) => c[0]?.includes("reply for first prompt"))).toBe(true);
      expect(second.send.mock.calls.some((c) => c[0]?.includes("reply for second prompt"))).toBe(true);
      expect(agent.hasResponseForPrompt).toHaveBeenCalledWith("_ai", 0, "second prompt");
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
