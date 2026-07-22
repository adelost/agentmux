import { expect, feature, unit } from "bdd-vitest";
import { createStopAll } from "./stop-all.mjs";

function fleet({ bridgeError = null, receiptError = null } = {}) {
  const calls = [];
  const stopAll = createStopAll({
    listAgents: () => [
      { name: "ai", backend: "tmux" },
      { name: "claw", backend: "tmux" },
      { name: "svc", backend: "native" },
    ],
    hasSession: async (_ctx, name) => name !== "claw",
    killSession: async (_ctx, name) => { calls.push(`kill:${name}`); },
    stopBridge: async () => {
      calls.push("bridge");
      if (bridgeError) throw bridgeError;
      return true;
    },
    collectRecoveryCandidates: async () => {
      calls.push("inventory");
      return [{ agent: "ai", pane: 0, interruptedAtMs: 10, evidence: "ask-partial" }];
    },
    recordRecovery: (candidates) => {
      calls.push(`receipt:${candidates.length}`);
      if (receiptError) throw receiptError;
    },
  });
  return { calls, stopAll };
}

feature("atomic fleet stop", () => {
  unit("the bridge stops before any session is killed", {
    given: ["a fleet with two live sessions and one dead", () => fleet()],
    when: ["stopping everything", async (f) => {
      const result = await f.stopAll({ configPath: "/cfg" });
      return { calls: f.calls, result };
    }],
    then: ["inventory and receipt precede kills; dead/native entries stay untouched", ({ calls, result }) => {
      expect(calls).toEqual(["inventory", "bridge", "receipt:1", "kill:ai"]);
      expect(result.stopped).toEqual(["ai", "bridge"]);
      expect(result.recovery).toHaveLength(1);
    }],
  });

  unit("a refused bridge stop kills zero sessions", {
    given: ["a bridge stop that times out", () => fleet({ bridgeError: new Error("did not stop cleanly") })],
    when: ["attempting the stop", async (f) => {
      const error = await f.stopAll({ configPath: "/cfg" }).catch((err) => err);
      return { calls: f.calls, error };
    }],
    then: ["the error propagates and no kill happened", ({ calls, error }) => {
      expect(error.message).toBe("did not stop cleanly");
      expect(calls).toEqual(["inventory", "bridge"]);
      expect(calls.filter((call) => call.startsWith("kill:"))).toHaveLength(0);
    }],
  });

  unit("an unwritable recovery receipt kills zero sessions", {
    given: ["a durable event append failure", () => fleet({ receiptError: new Error("ledger unavailable") })],
    when: ["attempting the stop", async (f) => {
      const error = await f.stopAll({ configPath: "/cfg" }).catch((err) => err);
      return { calls: f.calls, error };
    }],
    then: ["the failure is loud and no session is killed", ({ calls, error }) => {
      expect(error.message).toBe("ledger unavailable");
      expect(calls).toEqual(["inventory", "bridge", "receipt:1"]);
      expect(calls.some((call) => call.startsWith("kill:"))).toBe(false);
    }],
  });
});
