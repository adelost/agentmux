import { describe, expect, it, vi } from "vitest";
import { createHandlers } from "../handlers.mjs";

function durableMessage() {
  return {
    channelId: "removed-channel",
    id: "93001",
    text: "preserve this staged prompt",
    isBot: false,
    createdTimestamp: 9_300,
    resolvedTarget: { agentName: "skybar", pane: 3, dir: null },
    reply: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    startTyping: vi.fn(() => vi.fn()),
  };
}

/** WHAT: Creates the smallest handler seam for a persisted target. WHY: Keeps a removed channel mapping from hiding a staged pane delivery. */
function setup() {
  const stateData = {};
  const state = {
    get: (key, fallback) => Object.hasOwn(stateData, key) ? stateData[key] : fallback,
    set: (key, value) => { stateData[key] = value; },
  };
  const deliveryBroker = {
    enqueue: vi.fn((request) => ({ id: "job", ...request })),
    runExclusive: vi.fn(async (_name, _pane, work) => work()),
  };
  const handlers = createHandlers({
    agent: {},
    attachments: { buildPrompt: vi.fn(async (msg) => msg.text) },
    tts: { isEnabled: () => false },
    state,
    getMapping: () => null,
    overrides: new Map(),
    channelMap: () => new Map(),
    reloadConfig: () => {},
    deliveryBroker,
    loopGuardConfig: { enabled: false },
  });
  return { ...handlers, deliveryBroker };
}

describe("durable Discord target routing", () => {
  it("enqueues the persisted pane even after its live channel mapping disappears", async () => {
    const { onMessage, deliveryBroker } = setup();

    const result = await onMessage(durableMessage());

    expect(result).toEqual({ delivered: true, pending: true });
    expect(deliveryBroker.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "skybar",
      pane: 3,
      text: "preserve this staged prompt",
      idempotencyKey: "discord:removed-channel:93001",
    }));
  });
});
