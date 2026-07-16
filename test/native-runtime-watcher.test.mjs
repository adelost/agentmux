import { describe, expect, it, vi } from "vitest";
import {
  createNativeRuntimeWatcher,
  groupNativeTurns,
  nativeHistoryRows,
} from "../channels/native-runtime-watcher.mjs";

const events = [
  {
    type: "web",
    subtype: "user",
    text: "Do the canary",
    operationKey: "delivery:abc",
    at: 100,
  },
  {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "exec_command", input: { cmd: "npm test" } },
        { type: "text", text: "CANARY_OK" },
      ],
    },
    at: 200,
  },
  {
    type: "web",
    subtype: "turn-done",
    operationKey: "delivery:abc",
    code: 0,
    at: 300,
  },
];

describe("native runtime Discord watcher", () => {
  it("groups a completed runtime operation under its stable delivery key", () => {
    const turns = groupNativeTurns(events);
    expect(turns).toEqual([expect.objectContaining({
      id: "operation:delivery:abc",
      user: "Do the canary",
      complete: true,
      items: [
        { type: "tool", content: "Run npm test" },
        { type: "text", content: "CANARY_OK" },
      ],
    })]);
  });

  it("projects completed native turns into the orchestrator timeline shape", () => {
    expect(nativeHistoryRows("skybar-canary", 1, events)).toEqual([
      {
        agent: "skybar-canary",
        pane: 1,
        timestamp: new Date(100).toISOString(),
        role: "user",
        type: "text",
        content: "Do the canary",
      },
      {
        agent: "skybar-canary",
        pane: 1,
        timestamp: new Date(300).toISOString(),
        role: "assistant",
        type: "tool",
        content: "Run npm test",
      },
      {
        agent: "skybar-canary",
        pane: 1,
        timestamp: new Date(300).toISOString(),
        role: "assistant",
        type: "text",
        content: "CANARY_OK",
      },
    ]);
    expect(nativeHistoryRows("skybar-canary", 1, events, { sinceMs: 301 })).toEqual([]);
  });

  it("keeps an immediate failed turn visible even without assistant text", () => {
    const failed = groupNativeTurns([
      {
        type: "web",
        subtype: "user",
        text: "Run the protected action",
        operationKey: "delivery:denied",
        at: 400,
      },
      {
        type: "web",
        subtype: "turn-done",
        operationKey: "delivery:denied",
        code: 1,
        error: "permission denied: Bash",
        permissionDenied: true,
        at: 500,
      },
    ]);
    expect(failed).toEqual([expect.objectContaining({
      id: "operation:delivery:denied",
      code: 1,
      permissionDenied: true,
      items: [{ type: "text", content: "🔒 Behörighet nekad: permission denied: Bash" }],
    })]);
  });

  it("mirrors once across repeated polls and appends native context", async () => {
    const stored = {};
    const state = {
      get: vi.fn((key, fallback) => stored[key] ?? fallback),
      set: vi.fn((key, value) => { stored[key] = structuredClone(value); }),
    };
    const discord = {
      send: vi.fn(async () => {}),
      sendTyping: vi.fn(async () => {}),
    };
    const config = {
      "skybar-canary": {
        backend: "native",
        dir: "/tmp/canary",
        discord: { "channel-1": 0 },
        panes: [{ cmd: "native:claude", engine: "claude" }],
      },
    };
    const nativeRuntime = {
      history: vi.fn(async () => ({
        agent: {
          running: false,
          model: "claude-opus-4-8",
          effort: "high",
          context: { percent: 61.2, usedTokens: 122_400 },
        },
        events,
      })),
    };
    const watcher = createNativeRuntimeWatcher({
      nativeRuntime,
      agentsYamlPath: "unused",
      discord,
      state,
      pollMs: 60_000,
    });

    // Drive one pane directly; sharedConfig avoids filesystem config I/O.
    await watcher.check("skybar-canary", 0, config["skybar-canary"], config);
    await watcher.check("skybar-canary", 0, config["skybar-canary"], config);
    expect(discord.send).toHaveBeenCalledTimes(2);
    expect(discord.send.mock.calls[0][1]).toContain("`Run npm test`");
    expect(discord.send.mock.calls[0][1]).toContain("CANARY_OK");
    expect(discord.send.mock.calls[1][1]).toBe("_opus-4-8 high · context: 61% (122k)_");
  });

  it("mirrors an assistant-less native failure exactly once", async () => {
    const stored = {};
    const state = {
      get: (key, fallback) => stored[key] ?? fallback,
      set: (key, value) => { stored[key] = structuredClone(value); },
    };
    const discord = { send: vi.fn(async () => {}), sendTyping: vi.fn(async () => {}) };
    const config = {
      "skybar-canary": {
        backend: "native",
        dir: "/tmp/canary",
        discord: { "channel-1": 0 },
        panes: [{ cmd: "native:claude", engine: "claude" }],
      },
    };
    const nativeRuntime = {
      history: async () => ({
        agent: { running: false, context: null },
        events: [
          { type: "web", subtype: "user", text: "protected", operationKey: "delivery:nope", at: 10 },
          {
            type: "web",
            subtype: "turn-done",
            operationKey: "delivery:nope",
            code: 1,
            error: "permission denied: Bash",
            permissionDenied: true,
            at: 20,
          },
        ],
      }),
    };
    const watcher = createNativeRuntimeWatcher({
      nativeRuntime,
      agentsYamlPath: "unused",
      discord,
      state,
      log: () => {},
    });

    await watcher.check("skybar-canary", 0, config["skybar-canary"], config);
    await watcher.check("skybar-canary", 0, config["skybar-canary"], config);
    expect(discord.send).toHaveBeenCalledTimes(1);
    expect(discord.send.mock.calls[0][1]).toContain("Behörighet nekad");
  });

  it("does not resurrect partial text from an already-finished empty turn after restart", async () => {
    const stored = {};
    const state = {
      get: (key, fallback) => stored[key] ?? fallback,
      set: (key, value) => { stored[key] = structuredClone(value); },
    };
    const discord = { send: vi.fn(async () => {}) };
    const config = {
      "skybar-canary": {
        backend: "native",
        dir: "/tmp/canary",
        discord: { "channel-1": 0 },
        panes: [{ cmd: "native:claude", engine: "claude" }],
      },
    };
    let historyEvents = [
      { type: "web", subtype: "user", text: "interrupt me", operationKey: "delivery:old", at: 10 },
      { type: "web", subtype: "turn-done", operationKey: "delivery:old", code: 0, interrupted: true, at: 20 },
    ];
    const nativeRuntime = {
      history: async () => ({ agent: { running: false, context: null }, events: historyEvents }),
    };
    const firstWatcher = createNativeRuntimeWatcher({
      nativeRuntime,
      agentsYamlPath: "unused",
      discord,
      state,
      log: () => {},
    });
    await firstWatcher.check("skybar-canary", 0, config["skybar-canary"], config);
    expect(discord.send).not.toHaveBeenCalled();

    historyEvents = [
      historyEvents[0],
      { type: "assistant", message: { content: [{ type: "text", text: "recovered partial" }] }, at: 15 },
      historyEvents[1],
    ];
    const restartedWatcher = createNativeRuntimeWatcher({
      nativeRuntime,
      agentsYamlPath: "unused",
      discord,
      state,
      log: () => {},
    });
    await restartedWatcher.check("skybar-canary", 0, config["skybar-canary"], config);
    expect(discord.send).not.toHaveBeenCalled();
  });

  it("warns, parks and pushes once for an automatic native downgrade", async () => {
    const stored = {};
    const state = {
      get: (key, fallback) => stored[key] ?? fallback,
      set: (key, value) => { stored[key] = structuredClone(value); },
    };
    const discord = { send: vi.fn(async () => {}), sendTyping: vi.fn(async () => {}) };
    const notify = vi.fn(async () => {});
    const park = vi.fn();
    const unpark = vi.fn();
    const config = {
      "skybar-canary": {
        backend: "native",
        dir: "/tmp/canary",
        discord: { "channel-1": 0 },
        panes: [{ cmd: "native:claude", engine: "claude" }],
      },
    };
    const nativeRuntime = {
      history: async () => ({
        agent: {
          running: false,
          model: "fable",
          observedModel: "claude-sonnet-4-6",
          effort: "high",
          context: null,
        },
        events: [{
          webId: "boot:9",
          type: "web",
          subtype: "model-change",
          from: "claude-fable-5",
          to: "claude-sonnet-4-6",
          direction: "downgrade",
          kind: "model",
          cause: "automatic",
          expected: false,
          policy: "stop",
          source: "claude-assistant",
          at: 900,
        }],
      }),
    };
    const watcher = createNativeRuntimeWatcher({
      nativeRuntime,
      agentsYamlPath: "unused",
      discord,
      state,
      notify,
      park,
      unpark,
      log: () => {},
    });

    await watcher.check("skybar-canary", 0, config["skybar-canary"], config);
    await watcher.check("skybar-canary", 0, config["skybar-canary"], config);

    expect(discord.send).toHaveBeenCalledTimes(1);
    expect(discord.send.mock.calls[0][1]).toContain("STOPPAS");
    expect(park).toHaveBeenCalledWith(expect.objectContaining({ session: "skybar-canary", pane: 0 }));
    expect(unpark).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("releases the durable park when a later explicit native model setting clears the guard", async () => {
    const stored = {};
    const state = {
      get: (key, fallback) => stored[key] ?? fallback,
      set: (key, value) => { stored[key] = structuredClone(value); },
    };
    const discord = { send: vi.fn(async () => {}) };
    const park = vi.fn();
    const unpark = vi.fn();
    const config = {
      "skybar-canary": {
        backend: "native",
        dir: "/tmp/canary",
        discord: { "channel-1": 0 },
        panes: [{ cmd: "native:claude", engine: "claude" }],
      },
    };
    const nativeRuntime = {
      history: async () => ({
        agent: { running: false, context: null },
        events: [
          {
            webId: "boot:1",
            type: "web",
            subtype: "model-change",
            from: "fable",
            to: "sonnet",
            direction: "downgrade",
            kind: "model",
            expected: false,
            policy: "stop",
          },
          {
            webId: "boot:2",
            type: "web",
            subtype: "settings",
            model: "sonnet",
            clearedModelGuard: true,
          },
        ],
      }),
    };
    const watcher = createNativeRuntimeWatcher({
      nativeRuntime,
      agentsYamlPath: "unused",
      discord,
      state,
      notify: async () => {},
      park,
      unpark,
      log: () => {},
    });

    await watcher.check("skybar-canary", 0, config["skybar-canary"], config);
    expect(park).toHaveBeenCalledTimes(1);
    expect(unpark).toHaveBeenCalledWith(expect.objectContaining({
      session: "skybar-canary",
      pane: 0,
      detail: "explicit native model switch: sonnet",
    }));
    expect(discord.send).toHaveBeenCalledTimes(1);
  });
});
