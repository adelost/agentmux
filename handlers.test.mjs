import { feature, component, expect } from "bdd-vitest";
import { reconcileAllSessions } from "./handlers.mjs";

// Builds a stub agent module whose reconcileSession resolves to whatever
// the per-name map dictates. Names not in the map throw to mimic a
// fully-broken reconcile call (bug, not a no-op).
function fakeAgent(perName) {
  return {
    reconcileSession: async (name) => {
      if (!(name in perName)) throw new Error(`no entry for ${name}`);
      const value = perName[name];
      if (value instanceof Error) throw value;
      return value;
    },
  };
}

feature("reconcileAllSessions", () => {
  component("calls reconcileSession for each agent in order", {
    given: ["three agents with non-empty deltas", () => {
      const calls = [];
      const agent = {
        reconcileSession: async (name) => {
          calls.push(name);
          return { name, added: 1, respawned: [], mismatches: [], extras: 0 };
        },
      };
      return { agent, calls };
    }],
    when: ["reconciling all", async ({ agent, calls }) => {
      await reconcileAllSessions(agent, ["ai", "claw", "skybar"]);
      return calls;
    }],
    then: ["each agent called exactly once, in iteration order", (calls) => {
      expect(calls).toEqual(["ai", "claw", "skybar"]);
    }],
  });

  component("skips summaries with no deltas (skipped session, no changes)", {
    given: ["mixed session states", () => fakeAgent({
      ai: { name: "ai", added: 2, respawned: [], mismatches: [], extras: 0 },
      claw: { skipped: true, reason: "no session" },
      skybar: { name: "skybar", added: 0, respawned: [], mismatches: [], extras: 0 },
    })],
    when: ["reconciling all", async (agent) => reconcileAllSessions(agent, ["ai", "claw", "skybar"])],
    then: ["only ai (added=2) is in summaries", (summaries) => {
      expect(summaries.map((s) => s.name)).toEqual(["ai"]);
      expect(summaries[0].added).toBe(2);
    }],
  });

  component("isolates per-agent failures so other agents still reconcile", {
    given: ["three agents, middle one throws", () => {
      const logs = [];
      const agent = fakeAgent({
        ai: { name: "ai", added: 1, respawned: [], mismatches: [], extras: 0 },
        claw: new Error("tmux exploded"),
        skybar: { name: "skybar", added: 1, respawned: [], mismatches: [], extras: 0 },
      });
      return { agent, logs };
    }],
    when: ["reconciling all", async ({ agent, logs }) => {
      const summaries = await reconcileAllSessions(agent, ["ai", "claw", "skybar"], (msg) => logs.push(msg));
      return { summaries, logs };
    }],
    then: ["ai + skybar still summarized, claw error logged", ({ summaries, logs }) => {
      expect(summaries.map((s) => s.name)).toEqual(["ai", "skybar"]);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("claw");
      expect(logs[0]).toContain("tmux exploded");
    }],
  });

  component("includes summaries with respawns or mismatches even when added=0", {
    given: ["mixed delta types", () => fakeAgent({
      respawned_only: { name: "respawned_only", added: 0, respawned: [{ pane: 0 }], mismatches: [], extras: 0 },
      mismatched_only: { name: "mismatched_only", added: 0, respawned: [], mismatches: [{ pane: 1 }], extras: 0 },
      extras_only: { name: "extras_only", added: 0, respawned: [], mismatches: [], extras: 1 },
      no_deltas: { name: "no_deltas", added: 0, respawned: [], mismatches: [], extras: 0 },
    })],
    when: ["reconciling all", async (agent) => reconcileAllSessions(
      agent,
      ["respawned_only", "mismatched_only", "extras_only", "no_deltas"],
    )],
    then: ["three with deltas pass, no-delta one is filtered", (summaries) => {
      expect(summaries.map((s) => s.name)).toEqual(["respawned_only", "mismatched_only", "extras_only"]);
    }],
  });

  component("returns empty array when no agents have deltas", {
    given: ["all agents skipped or empty", () => fakeAgent({
      ai: { skipped: true, reason: "no config" },
      claw: { name: "claw", added: 0, respawned: [], mismatches: [], extras: 0 },
    })],
    when: ["reconciling all", async (agent) => reconcileAllSessions(agent, ["ai", "claw"])],
    then: ["empty summaries", (summaries) => {
      expect(summaries).toEqual([]);
    }],
  });
});
