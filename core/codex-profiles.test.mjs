import { feature, unit, expect } from "bdd-vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  CODEX_MODEL_STATE_KEY,
  CODEX_PROFILE_STATE_KEY,
  codexLoginCommand,
  codexModelOverride,
  codexProfileCatalog,
  isCodexProfileAuthenticated,
  prepareCodexProfile,
  resolveCodexProfile,
  selectedCodexProfile,
  setCodexModelOverride,
  setCodexProfile,
} from "./codex-profiles.mjs";

function memoryState(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    get: (key, fallback) => key in data ? data[key] : fallback,
    set: (key, value) => { data[key] = value; },
  };
}

function tempProfiles() {
  const home = join(tmpdir(), `amux-codex-profiles-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
  const env = { HOME: home };
  return { home, env, profiles: codexProfileCatalog(env), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

feature("Codex account profile selection", () => {
  unit("unconfigured pane starts on existing profile 1 and bare switch toggles to 2", {
    given: ["fresh durable state", () => {
      const state = memoryState();
      const catalog = codexProfileCatalog({ HOME: "/home/test" });
      return { state, catalog, current: selectedCodexProfile(state, "claw", 11, catalog) };
    }],
    when: ["resolving a bare switch", ({ current, catalog }) => ({ current, next: resolveCodexProfile("", current, catalog) })],
    then: ["1 toggles to 2", ({ current, next }) => {
      expect(current.id).toBe("1");
      expect(next.id).toBe("2");
    }],
  });

  unit("explicit profile selection persists per pane only", {
    given: ["two panes", () => ({ state: memoryState(), catalog: codexProfileCatalog({ HOME: "/home/test" }) })],
    when: ["selecting profile 2 on claw:11", ({ state, catalog }) => {
      setCodexProfile(state, "claw", 11, "2");
      return {
        selected: selectedCodexProfile(state, "claw", 11, catalog),
        neighbour: selectedCodexProfile(state, "claw", 10, catalog),
        raw: state.data[CODEX_PROFILE_STATE_KEY],
      };
    }],
    then: ["only claw:11 changes", ({ selected, neighbour, raw }) => {
      expect(selected.id).toBe("2");
      expect(neighbour.id).toBe("1");
      expect(raw).toEqual({ "claw:11": "2" });
    }],
  });

  unit("unknown explicit profile is rejected", {
    given: ["the two-profile catalog", () => codexProfileCatalog({ HOME: "/home/test" })],
    when: ["selecting 3", (catalog) => resolveCodexProfile("3", catalog[0], catalog)],
    then: ["null", (profile) => expect(profile).toBeNull()],
  });
});

feature("Codex profile filesystem boundary", () => {
  unit("secondary setup copies config and shares extensions, never auth", {
    given: ["a populated primary home", () => {
      const ctx = tempProfiles();
      const [primary, secondary] = ctx.profiles;
      mkdirSync(join(primary.home, "skills"), { recursive: true });
      mkdirSync(join(primary.home, "plugins"), { recursive: true });
      writeFileSync(join(primary.home, "config.toml"), 'model = "gpt-5.6-sol"\n');
      writeFileSync(join(primary.home, "auth.json"), JSON.stringify({ tokens: { access_token: "secret" } }));
      return { ...ctx, primary, secondary };
    }],
    when: ["preparing profile 2", ({ primary, secondary }) => prepareCodexProfile(secondary, primary)],
    then: ["non-secret setup is present and auth stays isolated", (_, ctx) => {
      expect(readFileSync(join(ctx.secondary.home, "config.toml"), "utf-8")).toContain("gpt-5.6-sol");
      expect(lstatSync(join(ctx.secondary.home, "skills")).isSymbolicLink()).toBe(true);
      expect(lstatSync(join(ctx.secondary.home, "plugins")).isSymbolicLink()).toBe(true);
      const safetyRules = readFileSync(
        join(ctx.secondary.home, "rules", "agentmux-execution-safety.rules"),
        "utf-8",
      );
      expect(safetyRules).toContain("Full autonomous mode");
      expect(safetyRules).not.toContain("prefix_rule");
      expect(isCodexProfileAuthenticated(ctx.secondary)).toBe(false);
      expect(isCodexProfileAuthenticated(ctx.primary)).toBe(true);
      ctx.cleanup();
    }],
  });

  unit("login command scopes OAuth to the chosen CODEX_HOME", {
    given: ["profile 2", () => ({ id: "2", home: "/home/test/.config/agent/codex-profiles/2" })],
    when: ["formatting setup", (profile) => codexLoginCommand(profile)],
    then: ["device auth is explicitly scoped", (command) => {
      expect(command).toContain("CODEX_HOME='/home/test/.config/agent/codex-profiles/2'");
      expect(command).toContain("codex login --device-auth");
    }],
  });
});

feature("pane-local model overrides", () => {
  unit("model and effort persist without affecting a neighbour", {
    given: ["fresh state", () => ({ state: memoryState() })],
    when: ["setting claw:11 to max", ({ state }) => {
      setCodexModelOverride(state, "claw", 11, "gpt-5.6-sol", "max");
      return {
        selected: codexModelOverride(state, "claw", 11),
        neighbour: codexModelOverride(state, "claw", 10),
        raw: state.data[CODEX_MODEL_STATE_KEY],
      };
    }],
    then: ["one scoped entry", ({ selected, neighbour, raw }) => {
      expect(selected).toEqual({ model: "gpt-5.6-sol", effort: "max" });
      expect(neighbour).toBeNull();
      expect(raw).toEqual({ "claw:11": { model: "gpt-5.6-sol", effort: "max" } });
    }],
  });

  unit("unsafe state values are ignored", {
    given: ["tampered durable state", () => memoryState({
      [CODEX_MODEL_STATE_KEY]: { "claw:11": { model: "$(touch /tmp/no)", effort: "max" } },
    })],
    when: ["reading", (state) => codexModelOverride(state, "claw", 11)],
    then: ["null", (value) => expect(value).toBeNull()],
  });
});
