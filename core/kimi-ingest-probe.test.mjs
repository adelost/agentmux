import { describe, expect, it } from "vitest";
import { createKimiIngestProbe, kimiComposerDraft } from "./kimi-ingest-probe.mjs";

const framed = (text = "") => ` ╭────────────────────────────────────╮\n │ > ${text} │\n ╰────────────────────────────────────╯ `;

function fixture({ prepared = null, foreign = null, screenPrefix = "", swallowFirstEnter = false } = {}) {
  let clock = 0;
  let composer = foreign;
  let accepted = false;
  const calls = [];
  const plan = prepared || { version: 1, nonce: "m-1234abcd", cursor: { kind: "test" } };
  if (prepared && foreign === null) composer = `AMUX-PROBE ${plan.nonce}`;
  const probe = createKimiIngestProbe({
    paneDialectName: () => "kimi",
    isBusy: async () => false,
    captureScreen: async () => `${screenPrefix}${framed(composer || "")}`,
    paneDir: () => "/tmp/kimi",
    agentConfig: () => ({ dir: "/tmp" }),
    capturePromptEchoCursor: async () => ({ kind: "test" }),
    typeLiteral: async (_name, text) => { calls.push(["type", clock]); composer = text; },
    sendEnter: async () => {
      calls.push(["enter", clock]);
      if (swallowFirstEnter && calls.filter(([kind]) => kind === "enter").length === 1) return;
      accepted = true;
      composer = null;
    },
    promptAccepted: () => accepted,
    wait: async (ms) => { clock += ms; },
    now: () => clock,
    randomNonce: () => "m-1234abcd",
    ingestTimeoutMs: 2_000,
    pasteSettleMs: 250,
    rescueAfterMs: 500,
  });
  return { probe, calls, plan, composer: () => composer };
}

describe("Kimi ingest probe recovery", () => {
  it("waits beyond the paste burst and rescues its exact draft with one later Enter", async () => {
    const fx = fixture({ swallowFirstEnter: true });
    let persisted = null;
    const result = await fx.probe("skydive", 12, { onPrepared: async (plan) => { persisted = plan; } });

    expect(result).toMatchObject({ ok: true, nonce: "m-1234abcd", recovered: true });
    expect(persisted).toEqual(fx.plan);
    expect(fx.calls).toEqual([["type", 0], ["enter", 250], ["enter", 750]]);
  });

  it("resumes a durable exact probe without typing it twice", async () => {
    const fx = fixture({ prepared: { version: 1, nonce: "m-1234abcd", cursor: { kind: "test" } } });
    const result = await fx.probe("skydive", 12, { prepared: fx.plan });

    expect(result).toMatchObject({ ok: true, nonce: "m-1234abcd" });
    expect(fx.calls).toEqual([["enter", 0]]);
  });

  it("never submits or clears foreign composer text", async () => {
    const fx = fixture({
      prepared: { version: 1, nonce: "m-1234abcd", cursor: { kind: "test" } },
      foreign: "AMUX-PROBE m-1234abcd plus human draft",
      screenPrefix: "> \nolder transcript\n",
    });
    const result = await fx.probe("skydive", 12, { prepared: fx.plan });

    expect(result).toEqual({ ok: false, reason: "composer contains foreign text" });
    expect(fx.calls).toEqual([]);
    expect(fx.composer()).toContain("human draft");
  });

  it("reads only the final composer row instead of a matching transcript line", () => {
    expect(kimiComposerDraft(`> AMUX-PROBE m-1234abcd\nassistant output\n${framed()}`)).toBe("");
  });

  it("recovers an exact final owned probe despite an older empty transcript prompt", async () => {
    const fx = fixture({
      prepared: { version: 1, nonce: "m-1234abcd", cursor: { kind: "test" } },
      screenPrefix: "> \nolder transcript\n",
    });
    const result = await fx.probe("skydive", 12, { prepared: fx.plan });

    expect(result).toMatchObject({ ok: true, nonce: "m-1234abcd" });
    expect(fx.calls).toEqual([["enter", 0]]);
  });
});
