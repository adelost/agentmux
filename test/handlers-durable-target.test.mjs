import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHandlers } from "../handlers.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parkPane, readParkState } from "../core/pane-park.mjs";

let parkDir, priorParkPath, priorEventsPath;
beforeEach(() => {
  parkDir = mkdtempSync(join(tmpdir(), "amux-target-park-"));
  priorParkPath = process.env.AMUX_PARK_STATE_PATH;
  priorEventsPath = process.env.AMUX_EVENTS_PATH;
  process.env.AMUX_PARK_STATE_PATH = join(parkDir, "parks.jsonl");
  process.env.AMUX_EVENTS_PATH = join(parkDir, "events.jsonl");
});
afterEach(() => {
  if (priorParkPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
  else process.env.AMUX_PARK_STATE_PATH = priorParkPath;
  if (priorEventsPath === undefined) delete process.env.AMUX_EVENTS_PATH;
  else process.env.AMUX_EVENTS_PATH = priorEventsPath;
  rmSync(parkDir, { recursive: true, force: true });
});

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
function setup({ paneCmd = null } = {}) {
  const stateData = {};
  const state = {
    get: (key, fallback) => Object.hasOwn(stateData, key) ? stateData[key] : fallback,
    set: (key, value) => { stateData[key] = value; },
  };
  const deliveryBroker = {
    enqueue: vi.fn((request) => ({ id: "job", ...request })),
    runExclusive: vi.fn(async (_name, _pane, work) => work()),
  };
  const agentsYamlPath = join(parkDir, "agents.json");
  if (paneCmd) {
    const panes = Array.from({ length: 4 }, (_, index) => ({ name: `pane-${index}`, cmd: index === 3 ? paneCmd : "bash" }));
    writeFileSync(agentsYamlPath, JSON.stringify({ skybar: { dir: parkDir, panes } }));
  }
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
    agentsYamlPath,
    loopGuardConfig: { enabled: false },
  });
  return { ...handlers, deliveryBroker };
}

describe("durable Discord target routing", () => {
  it.each([
    ["claude", false],
    ["codex", true],
  ])("reports a saved pause with engine-safe recovery for %s", async (paneCmd, expectsModelCommand) => {
    parkPane({ session: "skybar", pane: 3, detail: "operator pause" });
    const { onMessage, deliveryBroker } = setup({ paneCmd });
    const msg = durableMessage();

    await onMessage(msg);

    expect(deliveryBroker.enqueue).not.toHaveBeenCalled();
    expect(readParkState("skybar", 3)).not.toBeNull();
    const text = msg.reply.mock.calls[0][0];
    expect(text).toMatch(/^Message not sent to skybar:3:/);
    expect(text).toContain("Recorded reason: operator pause");
    expect(text).toContain("The blocked message is not replayed.");
    expect(text.includes(".3 //model <model>")).toBe(expectsModelCommand);
    expect(text).not.toMatch(/fallback|downgrad|modell|--force|\/restore/);
  });

  it("confirms only the next message on the same target without replaying the blocked one", async () => {
    parkPane({ session: "skybar", pane: 3, detail: "operator pause" });
    const { onMessage, deliveryBroker } = setup({ paneCmd: "claude" });
    await onMessage(durableMessage());
    expect(deliveryBroker.enqueue).not.toHaveBeenCalled();

    const next = { ...durableMessage(), id: "93002", text: "Continue on this model" };
    await onMessage(next);

    expect(deliveryBroker.enqueue).toHaveBeenCalledTimes(1);
    expect(deliveryBroker.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      agentName: "skybar", pane: 3, text: "Continue on this model",
      idempotencyKey: "discord:removed-channel:93002",
    }));
    expect(readParkState("skybar", 3)).toBeNull();
  });

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
