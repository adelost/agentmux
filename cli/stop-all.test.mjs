import { expect, feature, unit } from "bdd-vitest";
import { createStopAll } from "./stop-all.mjs";

function fleet({ bridgeError = null } = {}) {
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
  });
  return { calls, stopAll };
}

feature("atomic fleet stop", () => {
  unit("the bridge stops before any session is killed", {
    given: ["a fleet with two live sessions and one dead", () => fleet()],
    when: ["stopping everything", async (f) => {
      const plan = await f.stopAll({ configPath: "/cfg" });
      return { calls: f.calls, plan };
    }],
    then: ["bridge precedes kills, dead/native entries stay untouched", ({ calls, plan }) => {
      expect(calls).toEqual(["bridge", "kill:ai"]);
      expect(plan).toEqual(["ai", "bridge"]);
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
      expect(calls).toEqual(["bridge"]);
      expect(calls.filter((call) => call.startsWith("kill:"))).toHaveLength(0);
    }],
  });
});
