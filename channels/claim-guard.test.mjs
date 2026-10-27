import { expect, feature, component } from "bdd-vitest";
import { createClaimGuard } from "./claim-guard.mjs";
const held = { verdict: "hold", sentences: [{ text: "Testerna är gröna.", why: "source-missing" }] };
const reply = { text: "Testerna är gröna.", channelId: "human", paneKey: "claw:5", turnId: "turn-one", files: [] };
function fixture(options = {}) {
  const values = new Map(), posts = [], requests = [], records = [];
  const state = { get: (key, fallback) => structuredClone(values.get(key) || fallback), set: (key, value) => values.set(key, structuredClone(value)) };
  const deps = { state, check: async () => held, mode: () => "enforce", sendHeld: async p => posts.push(p),
    requestCorrection: p => { requests.push(p); return { id: "request" }; }, record: p => records.push(p), ...options };
  return { ...deps, guard: createClaimGuard(deps), posts, requests, records };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

feature("a claim hold cannot consume human input or repeat a send", () => {
  component("shadow passes unchanged before a checker settles", {
    given: ["a shadow checker that never resolves", () => fixture({ mode: () => "shadow", check: () => new Promise(() => {}) })],
    when: ["a completed reply arrives", async f => ({ f, result: await f.guard.assess(reply) })],
    then: ["no hold or correction was created", ({ f, result }) => { expect(result.text).toBe(reply.text); expect(f.requests).toHaveLength(0); }],
  });
  component("holds once, a second failed attempt is posted with a warning", {
    given: ["an unsupported original", () => fixture()],
    when: ["a correction also lacks sources", async f => ({ f, first: await f.guard.assess(reply), second: await f.guard.assess({ ...reply, turnId: "correction", prompt: "[amux claim-guard correction for turn-one]" }) })],
    then: ["only the first is held", ({ f, first, second }) => {
      expect(first.held).toBe(true); expect(second.held).toBeUndefined();
      expect(second.text).toContain("Källa saknas i 1 påståenden"); expect(f.requests).toHaveLength(1);
    }],
  });
  component("human arrival releases the original without waiting for Discord", {
    given: ["a held reply and a stalled Discord send", async () => {
      const f = fixture({ sendHeld: () => new Promise(() => {}) }); await f.guard.assess(reply); return f;
    }],
    when: ["the human writes", f => ({ f, result: f.guard.humanMessage({ channelId: "human", isBot: false }) })],
    then: ["the input callback has already returned", ({ result, f }) => {
      expect(result).toBeUndefined(); expect(f.state.get("claim_guard_v1").pending[reply.turnId].status).toBe("sending");
    }],
  });
  component("human arriving during evaluation prevents a later hold", {
    given: ["an evaluation still waiting", () => {
      let finish; const f = fixture({ check: () => new Promise(resolve => { finish = resolve; }) });
      const pending = f.guard.assess(reply); return { f, pending, finish: () => finish(held) };
    }],
    when: ["the human writes first", async x => { x.f.guard.humanMessage({ channelId: "human" }); x.finish(); return { ...x, result: await x.pending }; }],
    then: ["the reply is warned, not held", ({ result, f }) => { expect(result.text).toContain("Källa saknas"); expect(f.requests).toHaveLength(0); }],
  });
  component("unknown send survives restart and cannot be blindly resent", {
    given: ["a release whose response was lost", async () => {
      const f = fixture({ sendHeld: async () => { throw new Error("response lost"); }, log: () => {} });
      await f.guard.assess(reply); f.guard.humanMessage({ channelId: "human" }); await settle(); return f;
    }],
    when: ["the controller restarts and sees the same turn and another human", async f => {
      const next = createClaimGuard(f); next.humanMessage({ channelId: "human" }); return { f, result: await next.assess(reply) };
    }],
    then: ["the durable unknown outcome blocks replay", ({ f, result }) => {
      expect(result.held).toBe(true); expect(f.state.get("claim_guard_v1").pending[reply.turnId].status).toBe("unknown");
      expect(f.records.filter(r => r.event === "human-release-unknown")).toHaveLength(1);
    }],
  });
});
