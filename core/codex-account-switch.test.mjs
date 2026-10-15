import { feature, component, expect } from "bdd-vitest";
import { switchCodexAccount } from "./codex-account-switch.mjs";
import { homedir } from "node:os";
import { join } from "node:path";

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
  component("a genuinely changed native directory still rolls back the switch", {
    when: ["the resumed session changes its working directory", async () => {
      const fx = setup(), originalStatus = fx.options.statusDriver;
      fx.options.statusDriver = async () => {
        const native = await originalStatus();
        return { ...native, status: { ...native.status,
          directory: fx.calls.at(-1)?.profile.id === "2" ? "/different/pane" : "/pane" } };
      };
      return { result: await switchCodexAccount(fx.options), fx };
    }],
    then: ["the original account and exact session are restored", ({ result, fx }) => {
      expect(result.kind).toBe("failed");
      expect(result.error).toContain("working directory");
      expect(fx.calls.at(-1)).toMatchObject({ profile: { id: "1" }, resumeSessionId: "exact" });
    }],
  });
  component("a fresh handover resolves the native home abbreviation before finding its journal", {
    when: ["native status uses ~/ while the journal has an absolute cwd", async () => {
      const fx = setup(), originalStatus = fx.options.statusDriver;
      fx.options.continuity = null;
      fx.options.freshHandover = { ok: true, path: "/private/handover.json", text: "Read exact task evidence first." };
      fx.options.identityFor = dir => dir === join(homedir(), "project/.agents/5")
        ? { sessionId: "fresh-session", path: "/two/sessions/fresh.jsonl" } : null;
      fx.options.statusDriver = async () => {
        const native = await originalStatus();
        return { ...native, status: { ...native.status, directory: "~/project/.agents/5",
          session: fx.calls.at(-1)?.profile.id === "2" ? "fresh-session" : "exact" } };
      };
      return switchCodexAccount(fx.options);
    }],
    then: ["the exact new identity verifies instead of rolling back a correct fresh session", result =>
      expect(result).toMatchObject({ kind: "switched", fresh: true })],
  });
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
