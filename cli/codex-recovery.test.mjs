import { describe, it, expect } from "vitest";
import { createCodexRecovery } from "./codex-recovery.mjs";
import { CODEX_ACCOUNT_REQUESTS } from "./codex-account-switch.mjs";

describe("explicit account migration shares the settled JSONL sweep", () => {
  it("waits for an unchanged settled pass, and stops after the request is complete", async () => {
    const key = `${CODEX_ACCOUNT_REQUESTS}:claw:5`, data = { [key]: { phase: "pending", target: "2" } }, calls = [];
    const state = { get: (k, fallback) => data[k] ?? fallback, set: (k, value) => { data[k] = value; } };
    const recovery = createCodexRecovery({ state, agent: {}, configPath: "unused", notify: async () => {}, log: () => {},
      broker: { queue: { list: () => [] }, runExclusive: (_n, _p, f) => f() }, context: () => ({}),
      requestedSwitch: async (_ctx, name, pane) => { calls.push([name, pane]); data[key].phase = "complete"; return { key: "claw:5", status: "switched" }; } });
    await recovery.tick({ name: "claw", pane: 5 });
    expect(calls).toEqual([]);
    await recovery.tick({ name: "claw", pane: 5, idleBoundary: true });
    await recovery.tick({ name: "claw", pane: 5, idleBoundary: true });
    expect(calls).toEqual([["claw", 5]]);
  });
});
