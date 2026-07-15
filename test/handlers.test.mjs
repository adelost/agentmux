import { feature, component, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHandlers, renderCatchupLine, formatCatchupTime } from "../handlers.mjs";

// --- Test helpers ---

function mockMsg({ content = "hello", channelId = "ch1", id = "msg-1", isBot = false, createdTimestamp } = {}) {
  const replies = [];
  return {
    channelId,
    id,
    isBot,
    content,
    createdTimestamp,
    reply: vi.fn(async (text) => replies.push(text)),
    send: vi.fn(async () => {}),
    startTyping: vi.fn(() => vi.fn()),
    _replies: replies,
  };
}

function setup({ mappingOverride, channelMapEntries, agentsYamlPath, codexStatusDriver, queueFleetRestartRequest, scheduleBridgeRestart } = {}) {
  const defaultMapping = { name: "_ai", dir: "/home/user/project", pane: 0 };
  const mapping = mappingOverride ?? defaultMapping;
  const channelMapData = channelMapEntries ?? new Map([["ch1", defaultMapping]]);

  const overrides = new Map();
  const stateStore = {};
  const state = {
    get: vi.fn((key, fallback) => key in stateStore ? stateStore[key] : fallback),
    set: vi.fn((key, value) => { stateStore[key] = value; return value; }),
    toggle: vi.fn((key) => {
      stateStore[key] = !stateStore[key];
      return stateStore[key];
    }),
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
    sendEnter: vi.fn(async () => {}),
    typeLiteral: vi.fn(async () => {}),
    zoomPaneForPicker: vi.fn(async () => false),
    restorePaneZoom: vi.fn(async () => {}),
    restartCodex: vi.fn(async () => ({ ok: true })),
    sendAndWait: vi.fn(async () => "agent reply"),
    sendOnly: vi.fn(async () => {}),
    waitForPromptEcho: vi.fn(async () => true),
    capturePromptEchoCursor: vi.fn(async () => ({
      kind: "test-prompt-events-v1",
      seen: ["historical-event"],
    })),
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
  const deliveryBroker = {
    enqueue: vi.fn((request) => ({ id: `job-${request.metadata?.messageId || "test"}`, ...request })),
    enqueueAndWait: vi.fn(async (request) => {
      deliveryBroker.enqueue(request);
      return { delivered: true, pending: false, job: request };
    }),
    runExclusive: vi.fn(async (_name, _pane, work) => work()),
  };

  const { onMessage } = createHandlers({
    agent,
    attachments,
    tts,
    state,
    getMapping,
    overrides,
    channelMap: () => channelMapData,
    reloadConfig,
    agentsYamlPath,
    pollInterval: 1,
    codexStatusDriver,
    queueFleetRestartRequest,
    scheduleBridgeRestart,
    deliveryBroker,
  });

  return { onMessage, agent, attachments, tts, state, overrides, reloadConfig, channelMapData, deliveryBroker };
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

// Temp agents.yaml with a codex pane 0 for the default "_ai" mapping.
function writeCodexYaml() {
  const path = join(tmpdir(), `amux-handlers-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, `_ai:\n  dir: /home/user/project\n  panes:\n    - name: codex\n      cmd: codex resume --last\n`);
  return path;
}

function writeNativeCodexYaml() {
  const path = join(tmpdir(), `amux-handlers-native-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(path, `_ai:\n  dir: /home/user/project\n  backend: native\n  runtimeUrl: http://127.0.0.1:8812\n  panes:\n    - name: codex\n      cmd: native:codex\n      engine: codex\n`);
  return path;
}

function enableNativeAgent(setupResult) {
  setupResult.agent.isNativeTarget = vi.fn(() => true);
  setupResult.agent.nativeRuntime = {
    history: vi.fn(async () => ({
      agent: {
        id: "native-agent",
        engine: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        sessionId: "native-session",
        running: false,
        operation: null,
        context: { percent: 37.4, usedTokens: 74_800, windowTokens: 200_000 },
      },
      events: [],
    })),
    getResponse: vi.fn(async () => "native response text"),
    getContext: vi.fn(async () => ({ percent: 37, tokens: 74_800, source: "native-runtime" })),
    capturePane: vi.fn(async () => "native structured output"),
  };
  return setupResult;
}

function nativeStatus({ account = "one@example.com (Pro)", model = "gpt-5.6-sol", effort = "xhigh" } = {}) {
  return {
    version: "0.144.1",
    usageUrl: "https://chatgpt.com/codex/settings/usage",
    model: { id: model, effort, summaries: "auto", raw: `${model} (reasoning ${effort}, summaries auto)` },
    directory: "~/project/.agents/0",
    permissions: "Full Access",
    agentsMd: "<none>",
    account,
    collaborationMode: "Default",
    session: "session-1",
    context: { percentLeft: 60, used: "149K", total: "353K" },
    limits: {
      primary5h: { percentLeft: 82, resets: "17:13" },
      weekly: { percentLeft: 65, resets: "17:02 on 18 Jul" },
      spark5h: null,
      sparkWeekly: null,
    },
    warning: null,
  };
}

feature("/model dialect routing", () => {
  component("codex pane with a draft refuses the pane-local restart", {
    given: ["a Codex-backed channel whose pane has no identifiable composer", () => {
      const path = writeCodexYaml();
      const s = setup({ agentsYamlPath: path });
      s.agent.isBusy.mockResolvedValue(false);
      // capturePane keeps returning plain output → the draft/idle gate dies
      // before the Codex process can be restarted.
      return { ...s, path, msg: mockMsg({ content: "/model gpt-5.6-sol xhigh" }) };
    }],
    when: ["onMessage is called", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["failed closed before restarting", (_, { msg, agent }) => {
      const reply = msg.reply.mock.calls[0][0];
      expect(agent.restartCodex).not.toHaveBeenCalled();
      expect(reply).toMatch(/modelbyte avbrutet/i);
      expect(agent.sendOnly).not.toHaveBeenCalled();
    }],
  });

  component("bare /model on a codex pane hints the //model-with-effort form", {
    given: ["a codex-backed channel and bare /model", () => {
      const path = writeCodexYaml();
      const s = setup({ agentsYamlPath: path });
      s.agent.getContextPercent.mockReturnValue({ percent: 42, tokens: 84000, model: "gpt-5.6-sol" });
      return { ...s, path, msg: mockMsg({ content: "/model" }) };
    }],
    when: ["onMessage is called", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["reply carries pane-local restart hint incl. effort tiers", (_, { msg }) => {
      const reply = msg.reply.mock.calls[0][0];
      expect(reply).toMatch(/pane-local/i);
      expect(reply).toMatch(/xhigh/);
    }],
  });

  component("claude pane (no yaml) keeps the forwarding path", {
    given: ["default setup and /model with a claude alias", () => {
      const s = setup();
      return { ...s, msg: mockMsg({ content: "/model opus" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["the command is brokered and confirmed", (_, { msg, agent, deliveryBroker }) => {
      expect(deliveryBroker.enqueueAndWait).toHaveBeenCalledWith(expect.objectContaining({
        agentName: "_ai", pane: 0, text: "/model opus", kind: "slash",
      }));
      expect(agent.sendOnly).not.toHaveBeenCalled();
      expect(msg.reply.mock.calls[0][0]).toContain("sent `/model opus`");
    }],
  });

  component("codex model switch restarts only that pane with process-local overrides", {
    given: ["an idle Codex pane and a native status receipt", () => {
      const path = writeCodexYaml();
      const driver = vi.fn(async () => ({ ok: true, status: nativeStatus({ effort: "max" }) }));
      const s = setup({ agentsYamlPath: path, codexStatusDriver: driver });
      s.agent.isBusy.mockResolvedValue(false);
      s.agent.capturePane.mockResolvedValue("\n› Explain this codebase\n");
      s.agent.getContextPercent.mockReturnValue({
        percent: 42, tokens: 84000, model: "gpt-5.6-sol", effort: "xhigh",
      });
      return { ...s, path, driver, msg: mockMsg({ content: "/model gpt-5.6-sol max" }) };
    }],
    when: ["onMessage is called", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["restart carries Max and global-default guarantee", (_, { msg, agent }) => {
      expect(agent.restartCodex).toHaveBeenCalledTimes(1);
      expect(agent.restartCodex.mock.calls[0][2]).toMatchObject({ model: "gpt-5.6-sol", effort: "max" });
      expect(msg.reply.mock.calls[0][0]).toContain("global default orörd");
    }],
  });

  component("codex rollback preserves a draft that appears during verification", {
    given: ["native verification fails after a local human starts typing", () => {
      const path = writeCodexYaml();
      const driver = vi.fn(async () => ({ ok: false, stage: "parse", error: "status redraw" }));
      const s = setup({ agentsYamlPath: path, codexStatusDriver: driver });
      s.agent.isBusy.mockResolvedValue(false);
      s.agent.capturePane
        .mockResolvedValueOnce("\n› Explain this codebase\n")
        .mockResolvedValue("\n› keep my local draft\n");
      s.agent.getContextPercent.mockReturnValue({
        percent: 42, tokens: 84000, model: "gpt-5.6-sol", effort: "xhigh",
      });
      return { ...s, path, msg: mockMsg({ content: "/model gpt-5.6-sol max" }) };
    }],
    when: ["onMessage is called", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["no second restart destroys the draft", (_, { msg, agent }) => {
      expect(agent.restartCodex).toHaveBeenCalledTimes(1);
      expect(msg.reply.mock.calls[0][0]).toMatch(/Återställningen misslyckades också/);
      expect(msg.reply.mock.calls[0][0]).toMatch(/preserve pane input/);
    }],
  });
});

feature("Codex native /status and account switching", () => {
  component("/status returns the account plus rolling limits from Codex itself", {
    given: ["a Codex pane with a parsed native status", () => {
      const path = writeCodexYaml();
      const driver = vi.fn(async () => ({ ok: true, status: nativeStatus() }));
      return { ...setup({ agentsYamlPath: path, codexStatusDriver: driver }), path, driver, msg: mockMsg({ content: "/status" }) };
    }],
    when: ["onMessage is called", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["Discord sees account, profile and both reset windows", (_, { msg, driver }) => {
      expect(driver).toHaveBeenCalledTimes(1);
      const reply = msg.reply.mock.calls[0][0];
      expect(reply).toContain("one@example.com (Pro)");
      expect(reply).toContain("Codex-profil **1**");
      expect(reply).toContain("82% kvar");
      expect(reply).toContain("18 Jul");
    }],
  });

  component("first bare /switch gives one scoped login command without killing the pane", {
    given: ["profile 2 has not been authenticated", () => {
      const root = join(tmpdir(), `amux-handler-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const path = writeCodexYaml();
      process.env.AMUX_CODEX_PROFILE_2_HOME = join(root, "2");
      return { ...setup({ agentsYamlPath: path }), root, path, msg: mockMsg({ content: "/switch" }) };
    }],
    when: ["onMessage is called", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["one-time device login is shown and restart is untouched", (_, { msg, agent, root }) => {
      const reply = msg.reply.mock.calls[0][0];
      expect(reply).toContain("engångsinloggning");
      expect(reply).toContain("CODEX_HOME=");
      expect(reply).toContain("codex login --device-auth");
      expect(agent.restartCodex).not.toHaveBeenCalled();
      delete process.env.AMUX_CODEX_PROFILE_2_HOME;
      rmSync(root, { recursive: true, force: true });
    }],
  });

  component("bare /switch toggles an authenticated pane to profile 2 and verifies account", {
    given: ["profile 2 is authenticated", () => {
      const root = join(tmpdir(), `amux-handler-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const profileHome = join(root, "2");
      mkdirSync(profileHome, { recursive: true });
      writeFileSync(join(profileHome, "auth.json"), JSON.stringify({ tokens: { access_token: "test" } }));
      process.env.AMUX_CODEX_PROFILE_2_HOME = profileHome;
      const path = writeCodexYaml();
      const driver = vi.fn()
        .mockResolvedValueOnce({ ok: true, status: nativeStatus({ account: "one@example.com (Pro)" }) })
        .mockResolvedValueOnce({ ok: true, status: nativeStatus({ account: "two@example.com (Pro)" }) });
      const s = setup({ agentsYamlPath: path, codexStatusDriver: driver });
      s.agent.isBusy.mockResolvedValue(false);
      s.agent.capturePane.mockResolvedValue("\n› Explain this codebase\n");
      s.agent.getContextPercent.mockReturnValue({
        percent: 42, tokens: 84000, model: "gpt-5.6-sol", effort: "xhigh",
      });
      return { ...s, root, path, driver, msg: mockMsg({ content: "/switch" }) };
    }],
    when: ["onMessage is called", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["only this pane restarts and profile 2 status is returned", (_, { msg, agent, state, root }) => {
      expect(agent.restartCodex).toHaveBeenCalledTimes(1);
      expect(agent.restartCodex.mock.calls[0][2].profile.id).toBe("2");
      expect(state.get("codex_profile_by_pane", {})).toEqual({ "_ai:0": "2" });
      const reply = msg.reply.mock.calls[0][0];
      expect(reply).toContain("✅ Konto bytt");
      expect(reply).toContain("two@example.com (Pro)");
      expect(reply).toContain("Codex-profil **2**");
      delete process.env.AMUX_CODEX_PROFILE_2_HOME;
      rmSync(root, { recursive: true, force: true });
    }],
  });
});

feature("AMUX Code Discord command compatibility", () => {
  component("native /status reads structured runtime state instead of driving the Codex TUI", {
    given: ["a native Codex target", () => {
      const path = writeNativeCodexYaml();
      const driver = vi.fn();
      const s = enableNativeAgent(setup({ agentsYamlPath: path, codexStatusDriver: driver }));
      return { ...s, path, driver, msg: mockMsg({ content: "/status" }) };
    }],
    when: ["the command is handled", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["runtime model, effort, tokens and session are shown", (_, { msg, driver }) => {
      expect(driver).not.toHaveBeenCalled();
      const reply = msg.reply.mock.calls[0][0];
      expect(reply).toContain("native codex");
      expect(reply).toContain("gpt-5.6-sol");
      expect(reply).toContain("37% (75k/200k)");
      expect(reply).toContain("native-session");
    }],
  });

  component("native /model is durably brokered and applies on the next turn", {
    given: ["a native Codex target", () => {
      const path = writeNativeCodexYaml();
      const s = enableNativeAgent(setup({ agentsYamlPath: path }));
      return { ...s, path, msg: mockMsg({ content: "/model gpt-5.6-sol high" }) };
    }],
    when: ["the command is handled", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["no TUI restart occurs", (_, { msg, agent, deliveryBroker }) => {
      expect(deliveryBroker.enqueueAndWait).toHaveBeenCalledWith(expect.objectContaining({
        text: "/model gpt-5.6-sol high",
        kind: "slash",
      }));
      expect(agent.restartCodex).not.toHaveBeenCalled();
      expect(msg.reply.mock.calls[0][0]).toContain("gäller från nästa turn");
    }],
  });

  component("native /switch fails explicitly without touching tmux or account state", {
    given: ["a native Codex target", () => {
      const path = writeNativeCodexYaml();
      const s = enableNativeAgent(setup({ agentsYamlPath: path }));
      return { ...s, path, msg: mockMsg({ content: "/switch" }) };
    }],
    when: ["the command is handled", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["the limitation is visible and no pane restart occurs", (_, { msg, agent }) => {
      expect(agent.restartCodex).not.toHaveBeenCalled();
      expect(msg.reply.mock.calls[0][0]).toContain("separat native-target");
    }],
  });
});

feature("restart scope", () => {
  component("bare /restart remains bridge-only", {
    given: ["restart seams", () => {
      const queue = vi.fn();
      const schedule = vi.fn();
      return { ...setup({ queueFleetRestartRequest: queue, scheduleBridgeRestart: schedule }), queue, schedule, msg: mockMsg({ content: "/restart" }) };
    }],
    when: ["the command is handled", ({ onMessage, msg }) => onMessage(msg)],
    then: ["no fleet request is queued", (_, { msg, queue, schedule, state }) => {
      expect(queue).not.toHaveBeenCalled();
      expect(schedule).toHaveBeenCalledWith(500);
      expect(state.get("restartChannel")).toBe("ch1");
      expect(msg.reply.mock.calls[0][0]).toMatch(/bridge/i);
    }],
  });

  component("/restart all queues a one-shot fleet rebuild before bridge exit", {
    given: ["restart seams", () => {
      const queue = vi.fn();
      const schedule = vi.fn();
      return { ...setup({ queueFleetRestartRequest: queue, scheduleBridgeRestart: schedule }), queue, schedule, msg: mockMsg({ content: "/restart all" }) };
    }],
    when: ["the command is handled", ({ onMessage, msg }) => onMessage(msg)],
    then: ["the destructive scope is explicit and durable", (_, { msg, queue, schedule }) => {
      expect(queue).toHaveBeenCalledWith({ source: "discord" });
      expect(schedule).toHaveBeenCalledWith(500);
      expect(msg.reply.mock.calls[0][0]).toMatch(/alla konfigurerade tmux-sessioner/i);
      expect(msg.reply.mock.calls[0][0]).toMatch(/aktiva turns avbryts/i);
    }],
  });

  component("unknown restart scope fails without scheduling an exit", {
    given: ["restart seams", () => {
      const queue = vi.fn();
      const schedule = vi.fn();
      return { ...setup({ queueFleetRestartRequest: queue, scheduleBridgeRestart: schedule }), queue, schedule, msg: mockMsg({ content: "/restart maybe" }) };
    }],
    when: ["the command is handled", ({ onMessage, msg }) => onMessage(msg)],
    then: ["usage is returned", (_, { msg, queue, schedule }) => {
      expect(queue).not.toHaveBeenCalled();
      expect(schedule).not.toHaveBeenCalled();
      expect(msg.reply.mock.calls[0][0]).toContain("//restart all");
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

  component("native /peek reads structured history without starting a legacy progress timer", {
    given: ["an idle native target", () => {
      const path = writeNativeCodexYaml();
      return {
        ...enableNativeAgent(setup({ agentsYamlPath: path })),
        path,
        msg: mockMsg({ content: "/peek" }),
      };
    }],
    when: ["the command is handled", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["only native structured methods are used", (_, { msg, agent }) => {
      expect(agent.nativeRuntime.history).toHaveBeenCalledWith("_ai", 0);
      expect(agent.nativeRuntime.getResponse).toHaveBeenCalledWith("_ai", 0);
      expect(agent.nativeRuntime.getContext).toHaveBeenCalledWith("_ai", 0);
      expect(agent.startProgressTimer).not.toHaveBeenCalled();
      expect(agent.getResponse).not.toHaveBeenCalled();
      expect(msg.reply.mock.calls[0][0]).toContain("native response text");
    }],
  });

  component("native /raw never falls through to tmux capture", {
    given: ["a native target", () => {
      const path = writeNativeCodexYaml();
      return {
        ...enableNativeAgent(setup({ agentsYamlPath: path })),
        path,
        msg: mockMsg({ content: "/raw" }),
      };
    }],
    when: ["the command is handled", async ({ onMessage, msg, path }) => {
      await onMessage(msg);
      unlinkSync(path);
    }],
    then: ["the runtime snapshot is the only source", (_, { msg, agent }) => {
      expect(agent.nativeRuntime.capturePane).toHaveBeenCalledWith("_ai", 0);
      expect(agent.nativeRuntime.getContext).toHaveBeenCalledWith("_ai", 0);
      expect(agent.capturePane).not.toHaveBeenCalled();
      expect(msg.reply.mock.calls[0][0]).toContain("native structured output");
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
  component("durably enqueues the cleaned prompt", {
    given: ["a regular message", () => ({ ...setup(), msg: mockMsg({ content: "what is 2+2?" }) })],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["the broker receives one stable Discord identity", (result, { deliveryBroker }) => {
      expect(result).toEqual({ delivered: true, pending: true });
      expect(deliveryBroker.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        agentName: "_ai",
        pane: 0,
        text: "what is 2+2?",
        verifyText: "what is 2+2?",
        idempotencyKey: "discord:ch1:msg-1",
      }));
    }],
  });

  component("forwards a downloaded Discord image as one exact multiline prompt", {
    given: ["an attachment handler result with text and a retained local image", () => {
      const s = setup();
      const prompt = "granska bilden\n[image attached: /tmp/discord-media-proof.png]";
      s.attachments.buildPrompt.mockResolvedValue(prompt);
      return { ...s, prompt, msg: mockMsg({ content: "granska bilden" }) };
    }],
    when: ["the Discord bridge delivers the message", ({ onMessage, msg }) => onMessage(msg)],
    then: ["the complete image prompt is one queue job, unchanged", (_, { deliveryBroker, prompt }) => {
      expect(deliveryBroker.enqueue).toHaveBeenCalledTimes(1);
      expect(deliveryBroker.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        text: prompt,
        verifyText: prompt,
      }));
    }],
  });

  component("TTS enabled does not inject an amux say hint into the prompt", {
    given: ["a regular message while channel TTS is enabled", () => {
      const s = setup();
      s.tts.isEnabled.mockReturnValue(true);
      return { ...s, msg: mockMsg({ content: "status please" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["the queue receives exactly the user's prompt", (_, { deliveryBroker }) => {
      const prompt = deliveryBroker.enqueue.mock.calls[0][0].text;
      expect(prompt).toBe("status please");
      expect(prompt).not.toContain("tts on");
      expect(prompt).not.toContain("amux say");
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

  component("a queue storage failure stays retryable without claiming delivery", {
    given: ["the durable queue rejects the write", () => {
      const s = setup();
      s.deliveryBroker.enqueue.mockImplementation(() => { throw new Error("disk unavailable"); });
      return { ...s, msg: mockMsg({ content: "do not lose this" }) };
    }],
    when: ["onMessage is called", ({ onMessage, msg }) => onMessage(msg)],
    then: ["the handler returns an explicit failure and never touches tmux", (outcome, { agent }) => {
      expect(outcome).toEqual({ delivered: false, reason: "disk unavailable" });
      expect(agent.sendOnly).not.toHaveBeenCalled();
    }],
  });

  component("a Discord replay reuses one deterministic durable job", {
    given: ["the same Discord message is observed twice", () => {
      const s = setup();
      return { ...s, msg: mockMsg({ id: "durable-1", content: "late durable echo" }) };
    }],
    when: ["both paths enqueue", async ({ onMessage, msg }) => {
      await onMessage(msg);
      await onMessage(msg);
    }],
    then: ["both writes carry the same identity for storage-level dedupe", (_, { deliveryBroker }) => {
      expect(deliveryBroker.enqueue).toHaveBeenCalledTimes(2);
      expect(deliveryBroker.enqueue.mock.calls.map(([job]) => job.idempotencyKey))
        .toEqual(["discord:ch1:durable-1", "discord:ch1:durable-1"]);
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
    then: ["both prompts are persisted immediately; the broker owns later serialization", (_, { deliveryBroker }) => {
      expect(deliveryBroker.enqueue.mock.calls.map(([job]) => job.text))
        .toEqual(["first prompt", "second prompt"]);
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
