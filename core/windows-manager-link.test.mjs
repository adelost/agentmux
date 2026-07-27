// Windows Link connector: exactly-once answer flow and restart safety.

import { expect, feature, component } from "bdd-vitest";
import { planWindowsLinkMessage, runWindowsLinkCycle } from "./windows-manager-link.mjs";

const message = (over = {}) => ({
  clientMessageId: "m-win-1",
  target: "windows",
  kind: "text",
  body: "starta om WSL nu",
  ...over,
});

function harness({ messages = [], answer = "AMUX RECOVERED lokal recovery" } = {}) {
  const calls = { posts: [], saves: 0, turns: 0 };
  const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
  const fetchImpl = async (url, init) => {
    const route = url.replace("https://link.v1d.io", "");
    const body = JSON.parse(init.body || "{}");
    calls.posts.push({ route, body });
    if (route.startsWith("/api/link/connector/poll")) return { ok: true, json: async () => ({ messages }) };
    return { ok: true, json: async () => ({}) };
  };
  const deps = { saveState: () => { calls.saves += 1; } };
  const serializeTurn = (fn) => fn();
  const runManagerTurn = async () => { calls.turns += 1; return { answer, outcome: "RECOVERED" };
  };
  return {
    calls,
    state,
    deps: { fetchImpl, linkBase: "https://link.v1d.io", token: "win-token", state, deps, history: [], serializeTurn, runManagerTurn },
  };
}

feature("windows link cycle", () => {
  component("one claimed message is acked, answered, and replied exactly once", {
    given: ["one windows message and a working manager", () => harness({ messages: [message()] })],
    when: ["running the cycle twice (restart between)", async (ctx) => {
      const first = await runWindowsLinkCycle(ctx.deps);
      const second = await runWindowsLinkCycle(ctx.deps);
      return { first, second, ctx };
    }],
    then: ["exactly one ack, one turn, one reply across both runs", (r) => {
      expect(r.first).toEqual({ claimed: 1, handled: 1 });
      expect(r.second).toEqual({ claimed: 1, handled: 0 });
      expect(r.ctx.calls.posts.filter((p) => p.route.includes("/ack"))).toHaveLength(1);
      expect(r.ctx.calls.turns).toBe(1);
      const replies = r.ctx.calls.posts.filter((p) => p.route.includes("/reply"));
      expect(replies).toHaveLength(1);
      expect(replies[0].body).toMatchObject({ clientMessageId: "m-win-1", connectorId: "windows-1", body: "AMUX RECOVERED lokal recovery" });
      expect(r.ctx.state.linkMessages["m-win-1"].stage).toBe("replied");
    }],
  });

  component("a delivered-but-unreplied message resumes without re-acking", {
    given: ["state holding a delivered message", () => {
      const ctx = harness({ messages: [message()] });
      ctx.state.linkMessages = { "m-win-1": { stage: "delivered" } };
      return ctx;
    }],
    when: ["running the cycle", async (ctx) => runWindowsLinkCycle(ctx.deps)],
    then: ["no second ack, one reply", (result, ctx) => {
      expect(result).toEqual({ claimed: 1, handled: 1 });
      expect(ctx.calls.posts.filter((p) => p.route.includes("/ack"))).toHaveLength(0);
      expect(ctx.calls.posts.filter((p) => p.route.includes("/reply"))).toHaveLength(1);
    }],
  });

  component("planWindowsLinkMessage stages", {
    given: ["three state shapes", () => ({})],
    when: ["planning", () => [
      planWindowsLinkMessage({ message: message(), stateEntry: null }),
      planWindowsLinkMessage({ message: message(), stateEntry: { stage: "delivered" } }),
      planWindowsLinkMessage({ message: message(), stateEntry: { stage: "replied" } }),
    ]],
    then: ["deliver, await-reply, skip", (plans) => {
      expect(plans.map((p) => p.action)).toEqual(["deliver", "await-reply", "skip"]);
    }],
  });
});
