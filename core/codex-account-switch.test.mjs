import { feature, component, expect } from "bdd-vitest";
import { switchCodexAccount } from "./codex-account-switch.mjs";

function setup({ continuity = true, wrongSession = false } = {}) {
  const calls = [], data = {};
  let profile = "1";
  const state = { get: (key, fallback = {}) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  const options = { state, name: "lsrc", pane: 5, current: { id: "1", home: "/one" }, target: { id: "2", home: "/two" },
    continuity: { ok: continuity, sessionId: "exact", reason: "unavailable" }, expectedEmail: "second@example.com",
    agent: { isBusy: async () => false, captureScreen: async () => "› \n gpt-6.1-sol xhigh · /pane",
      getContext: async () => ({ model: "gpt-6.1-sol", effort: "xhigh" }),
      restartCodex: async (_name, _pane, launch) => { calls.push(launch); profile = launch.profile.id; } },
    statusDriver: async () => ({ ok: true, status: { session: profile === "2" && wrongSession ? "foreign" : "exact",
      directory: "/pane",
      account: `${profile === "2" ? "second" : "first"}@example.com (Pro)`, model: { id: "gpt-6.1-sol", effort: "xhigh" } } }) };
  return { options, calls, data };
}

feature("manual and automatic Codex account transitions share continuity verification", () => {
  for (const wrongModel of [false, true]) {
    component(`fresh handover keeps model and rollback, wrong model=${wrongModel}`, {
      when: ["the source session cannot be transferred", async () => {
        const fx = setup(), originalStatus = fx.options.statusDriver;
        fx.options.continuity = null;
        fx.options.freshHandover = { ok: true, path: "/private/handover.json", text: "Read exact task evidence first." };
        fx.options.identityFor = () => ({ sessionId: "fresh-session", path: "/two/sessions/fresh.jsonl" });
        fx.options.statusDriver = async (...args) => {
          const result = await originalStatus(...args);
          if (fx.calls.at(-1)?.profile.id === "2") return { ...result, status: { ...result.status, session: "fresh-session",
            model: { id: wrongModel ? "wrong-model" : "gpt-6.1-sol", effort: "xhigh" } } };
          return result;
        };
        return { fx, result: await switchCodexAccount(fx.options) };
      }],
      then: ["only a verified fresh identity continues and failures restore the original exact session", ({ fx, result }) => {
        expect(result.kind).toBe(wrongModel ? "failed" : "switched");
        expect(fx.calls[0]).toMatchObject({ newSession: true, model: "gpt-6.1-sol", effort: "xhigh" });
        if (wrongModel) expect(fx.calls.at(-1)).toMatchObject({ profile: { id: "1" }, resumeSessionId: "exact" });
        else expect(result).toMatchObject({ fresh: true, text: "Read exact task evidence first." });
      }],
    });
  }
  for (const kind of ["verified", "unavailable", "wrong-session"]) {
    component(`${kind} account transition preserves the requested session`, {
      given: ["the actual shared switch with engine IO replaced", () => setup({ continuity: kind !== "unavailable", wrongSession: kind === "wrong-session" })],
      when: ["switching the one pane", async fx => ({ fx, result: await switchCodexAccount(fx.options) })],
      then: ["only verified continuity continues, failures preserve or restore the source", ({ fx, result }) => {
        expect(result.kind).toBe(kind === "verified" ? "switched" : "failed");
        if (kind === "unavailable") expect(fx.calls).toHaveLength(0);
        else expect(fx.calls[0]).toMatchObject({ resumeSessionId: "exact", model: "gpt-6.1-sol", effort: "xhigh" });
        if (kind === "wrong-session") expect(fx.calls.at(-1).profile.id).toBe("1");
      }],
    });
  }
});
