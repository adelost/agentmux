import { feature, component, unit, expect } from "bdd-vitest";
import { startFreshCodexSession } from "./codex-fresh-session.mjs";

feature("explicit fresh Terra session verifies identity before releasing work", () => {
  for (const kind of ["verified", "working", "queued", "old-identity"]) {
    component(`${kind} cannot silently reset or replay the old task`, {
      given: ["the fresh session coordinator with engine IO replaced", () => {
        const data = { codex_session_by_pane_profile_v1: { "skydive:4@1": { sessionId: "old", model: "gpt-6-astra" } } }, calls = [];
        return { data, calls, state: { get: (key, fallback = {}) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } } };
      }],
      when: ["starting one stopped pane", async fx => {
        try {
          return { fx, result: await startFreshCodexSession({ state: fx.state, name: "skydive", pane: 4, targetModel: "gpt-6.1-terra", targetEffort: "xhigh", unpark: () => {},
            queue: { acquireSessionLease: () => ({ release() {} }), list: () => kind === "queued" ? [{ status: "pending" }] : [] },
            agent: { paneProcessState: async () => ({ running: kind === "working" }), ensureReady: async (_n, _p, launch) => fx.calls.push(launch) },
            statusDriver: async () => ({ ok: true, status: { session: kind === "old-identity" ? "old" : "new", model: { id: "gpt-6.1-terra", effort: "xhigh" } } }) }) };
        } catch (error) { return { fx, error }; }
      }],
      then: ["only a new verified Terra session becomes ready; no prior prompt is sent", ({ fx, result, error }) => {
        if (kind === "verified") {
          expect(result.sessionId).toBe("new");
          expect(fx.data.codex_session_by_pane_profile_v1["skydive:4@1"].supersededSessionId).toBe("old");
          expect(fx.calls[0]).toMatchObject({ newSession: true, model: "gpt-6.1-terra", effort: "xhigh" });
        } else { expect(error).toBeDefined(); if (["working", "queued"].includes(kind)) expect(fx.calls).toHaveLength(0); }
      }],
    });
  }
});

feature("a fresh session starts only the fleet model", () => {
  unit("a Sol target is refused before any pane is touched", {
    when: ["asking for a new Sol session", () => startFreshCodexSession({ state: {}, queue: {}, agent: {}, name: "skydive", pane: 4,
      targetModel: "gpt-6.1-sol", targetEffort: "xhigh" }).then(() => null, error => error)],
    then: ["it names the Terra requirement", (error) => expect(error?.message).toMatch(/terra xhigh/u)],
  });
});
