import { feature, unit, expect } from "bdd-vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync, lstatSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  CODEX_MODEL_STATE_KEY,
  CODEX_PROFILE_STATE_KEY,
  codexLoginCommand,
  codexModelCatalog,
  codexModelOverride,
  codexProfileCatalog,
  isCodexProfileAuthenticated,
  prepareCodexProfile,
  resolveCatalogCodexModel,
  resolveCodexModelName,
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
  unit("friendly model names resolve to exact Codex ids", {
    given: ["the documented Astra shortcuts", () => ["astra", "gpt-6", "gpt-6-astra"]],
    when: ["resolving each model name", (names) => names.map(resolveCodexModelName)],
    then: ["every spelling selects GPT-6 Astra", (models) => {
      expect(models).toEqual(["gpt-6-astra", "gpt-6-astra", "gpt-6-astra"]);
    }],
  });

  unit("the Sol shortcut resolves back to the fleet default", {
    given: ["the short Sol name", () => "sol"],
    when: ["resolving it", resolveCodexModelName],
    then: ["it selects GPT-5.6 Sol", (model) => expect(model).toBe("gpt-5.6-sol")],
  });

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

// The account catalog on 2026-10-02, when "gpt-6.1" was accepted unchecked.
const catalog = (...ids) => ({ ok: true, models: ids.map(id => ({ id, listed: id !== "gpt-reserve" })) });
const ACCOUNT = catalog("gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-reserve", "gpt-5.6-sol");

feature("model requests resolve against the account's Codex catalog", () => {
  unit("a family name with a single model selects that model", {
    when: ["asking for gpt-6.1", () => resolveCatalogCodexModel("gpt-6.1", ACCOUNT)],
    then: ["it selects gpt-6.1-sol and keeps what was asked", (resolved) => {
      expect(resolved).toEqual({ ok: true, model: "gpt-6.1-sol", requested: "gpt-6.1" });
    }],
  });

  unit("exact ids and the documented shortcuts pass unchanged", {
    when: ["resolving each", () => ["gpt-6.1-sol", "sol", "gpt-6"].map(name => resolveCatalogCodexModel(name, ACCOUNT).model)],
    then: ["each selects its own model", (models) => expect(models).toEqual(["gpt-6.1-sol", "gpt-5.6-sol", "gpt-6-astra"])],
  });

  unit("an unknown name is refused with the models to choose from", {
    when: ["asking for gpt-7", () => resolveCatalogCodexModel("gpt-7", ACCOUNT)],
    then: ["only listed models are offered", (resolved) => {
      expect(resolved.ok).toBe(false);
      expect(resolved.reason).toBe("gpt-7 is not a Codex model on this account. Available: gpt-6.1-sol, gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-5.6-sol");
    }],
  });

  unit("a family with several models asks which one", {
    when: ["asking for gpt-7 when two exist", () => resolveCatalogCodexModel("gpt-7", catalog("gpt-7-sol", "gpt-7-luna", "gpt-6-astra"))],
    then: ["only that family is listed", (resolved) => {
      expect(resolved).toEqual({ ok: false, reason: "gpt-7 matches several models, pick one: gpt-7-sol, gpt-7-luna" });
    }],
  });

  unit("the catalog is read from the profile's own Codex home", {
    given: ["a profile whose Codex cached one listed and one hidden model", () => {
      const home = join(tmpdir(), `amux-codex-catalog-${process.pid}-${Date.now()}`);
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "models_cache.json"), JSON.stringify({ models: [
        { slug: "gpt-6.1-sol", visibility: "list" }, { slug: "codex-auto-review", visibility: "hide" }] }));
      return home;
    }],
    when: ["reading it", (home) => codexModelCatalog({ home })],
    then: ["both are known, only the listed one is offered", (read, home) => {
      try {
        expect(read).toEqual({ ok: true, models: [{ id: "gpt-6.1-sol", listed: true }, { id: "codex-auto-review", listed: false }] });
      } finally { rmSync(home, { recursive: true, force: true }); }
    }],
  });

  unit("a missing catalog refuses instead of guessing", {
    when: ["resolving without a readable catalog", () => resolveCatalogCodexModel("gpt-6.1",
      codexModelCatalog({ home: join(tmpdir(), "amux-no-codex-home") }))],
    then: ["the change is refused with the path", (resolved) => {
      expect(resolved.ok).toBe(false);
      expect(resolved.reason).toMatch(/cannot read the Codex model list at .*amux-no-codex-home\/models_cache\.json/);
    }],
  });
});
