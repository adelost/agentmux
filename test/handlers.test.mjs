import { feature, component, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createHandlers } from "../handlers.mjs";

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

  const agent = {
    getResponse: vi.fn(async () => "response text"),
    getResponseSegments: vi.fn(async () => ["agent reply"]),
    isBusy: vi.fn(async () => false),
    capturePane: vi.fn(async () => "raw pane output"),
    getContextPercent: vi.fn(() => ({ percent: 42, tokens: 84000 })),
    dismissBlockingPrompt: vi.fn(async () => true),
    sendEscape: vi.fn(async () => {}),
    sendAndWait: vi.fn(async () => "agent reply"),
    sendOnly: vi.fn(async () => {}),
    startProgressTimer: vi.fn(() => ({ timer: setInterval(() => {}, 99999), sentCount: () => 0 })),
  };

  const attachments = {
    buildPrompt: vi.fn(async (msg) => msg.content),
  };

  const tts = {
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
    given: ["a /peek message", () => ({ ...setup(), msg: mockMsg({ content: "/peek" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["replies with agent response and context%", (_, { msg, agent }) => {
      expect(agent.getResponse).toHaveBeenCalledWith("_ai", 0);
      expect(agent.getContextPercent).toHaveBeenCalledWith("/home/user/project");
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
    given: ["a message with .1 prefix", () => ({ ...setup(), msg: mockMsg({ content: ".1 /peek" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["agent.getResponse called with pane 1", (_, { agent }) => {
      expect(agent.getResponse).toHaveBeenCalledWith("_ai", 1);
    }],
  });
});

feature("processMessage pipeline", () => {
  component("sends prompt to agent and replies", {
    given: ["a regular message", () => ({ ...setup(), msg: mockMsg({ content: "what is 2+2?" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["agent receives prompt and reply sent", (_, { msg, agent }) => {
      expect(agent.sendAndWait).toHaveBeenCalledWith("_ai", "what is 2+2?", 0);
      expect(msg.reply).toHaveBeenCalled();
      expect(msg.reply.mock.calls[0][0]).toContain("agent reply");
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

  component("replies with timeout on killed process", {
    given: ["agent that times out", () => {
      const s = setup();
      s.agent.sendAndWait.mockRejectedValue(Object.assign(new Error("timeout"), { killed: true }));
      return { ...s, msg: mockMsg({ content: "slow request" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["replies with Timeout", (_, { msg }) => {
      expect(msg.reply).toHaveBeenCalledWith("Timeout");
    }],
  });

  component("replies with error message on failure", {
    given: ["agent that throws", () => {
      const s = setup();
      s.agent.sendAndWait.mockRejectedValue(new Error("connection lost"));
      return { ...s, msg: mockMsg({ content: "broken" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["replies with error", (_, { msg }) => {
      expect(msg.reply).toHaveBeenCalledWith("connection lost");
    }],
  });

  component("calls tts.sendFollowup after reply", {
    given: ["a regular message", () => ({ ...setup(), msg: mockMsg({ content: "hi" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["tts.sendFollowup was called with response text", (_, { tts }) => {
      expect(tts.sendFollowup).toHaveBeenCalled();
      expect(tts.sendFollowup.mock.calls[0][1]).toBe("agent reply");
    }],
  });
});

feature("message injection", () => {
  component("first message starts sendAndWait, second injects via sendOnly", {
    given: ["two messages arriving simultaneously", () => {
      const s = setup();
      s.agent.sendAndWait.mockImplementation(async (name, prompt) => prompt);
      return { ...s, msg1: mockMsg({ content: "first" }), msg2: mockMsg({ content: "second" }) };
    }],
    when: ["both messages are sent", ({ onMessage, msg1, msg2 }) =>
      Promise.all([onMessage(msg1), onMessage(msg2)])],
    then: ["first uses sendAndWait, second uses sendOnly", (_, { agent }) => {
      expect(agent.sendAndWait).toHaveBeenCalledTimes(1);
      expect(agent.sendOnly).toHaveBeenCalledWith("_ai", "second", 0);
    }],
  });
});
