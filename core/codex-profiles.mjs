// Account-profile registry for Codex panes.
//
// Authentication is scoped by CODEX_HOME.  Profile 1 deliberately points at
// the user's existing ~/.codex so adopting agentmux does not move credentials
// or history.  Profile 2 is an isolated home used for the second ChatGPT
// account.  Pane→profile and pane→model selections live in agentmux's durable
// state file; no access or refresh token is ever copied into that state.

import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { CODEX_EXTERNAL_NAVIGATION_RULES } from "./execution-safety.mjs";

export const CODEX_PROFILE_STATE_KEY = "codex_profile_by_pane";
export const CODEX_MODEL_STATE_KEY = "codex_model_by_pane";

// Mattias 2026-10-11: no pane runs Astra. Mattias 2026-10-27 (voice to api:0):
// every Codex pane runs GPT-6.1 Terra instead of Sol.
/** WHAT: Resolves the model every Codex pane runs by default. WHY: Keeps launch, new sessions and account recovery on one model. */
export const FLEET_CODEX_MODEL = "gpt-6.1-terra";
const CODEX_MODEL_ALIASES = Object.freeze({
  astra: "gpt-6-astra",
  "gpt-6": "gpt-6-astra",
  sol: "gpt-6.1-sol",
  terra: FLEET_CODEX_MODEL,
  "gpt-5.6": "gpt-5.6-sol",
});

/** WHAT: Resolves friendly AMUX model names to stable wire ids. WHY: Keeps operator shorthand from reaching Codex as an invalid model. */
export function resolveCodexModelName(requested) {
  const name = String(requested || "").trim().toLowerCase();
  return CODEX_MODEL_ALIASES[name] || name;
}

/** WHAT: Checks a Codex launch against Mattias's current model policy. WHY: Prevents old Astra selections from starting through wake, retry or account recovery. */
export function allowedCodexLaunchModel(requested) {
  const model = resolveCodexModelName(requested || FLEET_CODEX_MODEL);
  return /^gpt-6-astra(?:-|$)/u.test(model)
    ? { ok: false, reason: "Mattias's model rule forbids Astra. Use GPT-6.1 Terra; if the old session cannot compact, use amux model AGENT -p N terra xhigh --new-session." }
    : { ok: true, model };
}

const execFileAsync = promisify(execFile);

// The server answers by client version, and every Codex sharing a home
// rewrites models_cache.json: at 19:15 on 2026-10-02 a 0.155.1 client left a
// cache without gpt-6.1-sol while the panes ran 0.159.2. So ask the same
// `codex` the panes are launched with, for this profile's home.
// It runs in the home directory: Codex stops when its working directory is gone,
// and the bridge's own is the package directory every `npm install --global`
// replaces (2026-10-11: Discord's /model refused every Codex pane after that install).
/** WHAT: Reads the models the installed Codex offers for a profile. WHY: Keeps model checks on what the pane's own Codex can run. */
export async function codexModelCatalog(profile, { run = execFileAsync } = {}) {
  try {
    const { stdout } = await run("codex", ["debug", "models"], {
      cwd: homedir(), env: { ...process.env, CODEX_HOME: profile.home }, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
    const models = JSON.parse(stdout).models;
    if (!Array.isArray(models)) throw new Error("no models list");
    return { ok: true, models: models.filter(model => typeof model?.slug === "string")
      .map(model => ({ id: model.slug, listed: model.visibility !== "hide" })) };
  } catch (error) {
    const detail = String(error.stderr || error.message).trim().split("\n").at(-1);
    return { ok: false, reason: `could not list the Codex models for ${profile.home} (${detail})` };
  }
}

// On 2026-10-02 "gpt-6.1" was accepted though Codex only offers gpt-6.1-sol,
// and every later prompt to lsrc:4 was refused without a reply.
/** WHAT: Resolves a requested model to an id the account's catalog offers. WHY: Prevents a model the account cannot run from being selected. */
export function resolveCatalogCodexModel(requested, catalog) {
  if (!catalog.ok) return catalog;
  const name = resolveCodexModelName(requested);
  if (catalog.models.some(model => model.id === name)) return { ok: true, model: name };
  const listed = catalog.models.filter(model => model.listed).map(model => model.id);
  const family = listed.filter(id => id.startsWith(`${name}-`));
  if (family.length === 1) return { ok: true, model: family[0], requested: name };
  return { ok: false, reason: family.length
    ? `${name} matches several models, pick one: ${family.join(", ")}`
    : `${name} is not a Codex model on this account. Available: ${listed.join(", ")}` };
}

export const codexPaneKey = (name, pane) => `${name}:${Number(pane) || 0}`;

export function codexProfileCatalog(env = process.env) {
  const home = resolve(env.HOME || "~");
  const root = resolve(env.AMUX_CODEX_PROFILES_DIR || join(home, ".config", "agent", "codex-profiles"));
  return [
    {
      id: "1",
      home: resolve(env.AMUX_CODEX_PROFILE_1_HOME || join(home, ".codex")),
      primary: true,
    },
    {
      id: "2",
      home: resolve(env.AMUX_CODEX_PROFILE_2_HOME || join(root, "2")),
      primary: false,
    },
  ];
}

export function selectedCodexProfile(state, name, pane, catalog = codexProfileCatalog()) {
  const key = codexPaneKey(name, pane);
  const selected = state?.get?.(CODEX_PROFILE_STATE_KEY, {})?.[key];
  return catalog.find((profile) => profile.id === String(selected)) || catalog[0];
}

/** Empty/next toggles; explicit 1 or 2 selects deterministically. */
export function resolveCodexProfile(requested, current, catalog = codexProfileCatalog()) {
  const value = String(requested || "").trim().toLowerCase();
  if (!value || value === "next" || value === "toggle") {
    const index = Math.max(0, catalog.findIndex((profile) => profile.id === current?.id));
    return catalog[(index + 1) % catalog.length];
  }
  return catalog.find((profile) => profile.id.toLowerCase() === value) || null;
}

function updatePaneMap(state, key, change) {
  if (state.updateKey) return state.updateKey(key, current => change({ ...(current || {}) }));
  const value = change({ ...(state.get(key, {}) || {}) });
  state.set(key, value);
  return value;
}

/** WHAT: Stores one pane's account selection atomically. WHY: Prevents CLI and bridge writers from losing each other's choices. */
export function setCodexProfile(state, name, pane, profileId) {
  return updatePaneMap(state, CODEX_PROFILE_STATE_KEY, profiles => {
    profiles[codexPaneKey(name, pane)] = String(profileId);
    return profiles;
  });
}

export function codexModelOverride(state, name, pane) {
  const value = state?.get?.(CODEX_MODEL_STATE_KEY, {})?.[codexPaneKey(name, pane)];
  if (!value || !/^[a-z0-9._-]+$/i.test(String(value.model || ""))) return null;
  const effort = value.effort == null ? null : String(value.effort).toLowerCase();
  if (effort && !/^(minimal|low|medium|high|xhigh|max|ultra)$/.test(effort)) return null;
  return { model: String(value.model), effort };
}

/** WHAT: Resolves explicit launch, saved choice, previous session, then default.
 *  WHY: A restart preserves a deliberate model choice; defaults initialize unselected panes. */
export function resolveCodexModelSelection({ launch, override, configured, previous } = {}) {
  if (launch?.model) return { model: launch.model, effort: launch.effort ?? null, source: "launch" };
  if (override?.model) return { ...override, source: "override" };
  if (previous?.model) return { model: previous.model, effort: previous.effort ?? null, source: "history" };
  if (configured?.model) return {
    model: configured.model,
    effort: configured.effort ?? previous?.effort ?? null,
    source: "config",
  };
  return previous?.model
    ? { model: previous.model, effort: previous.effort ?? null, source: "history" }
    : null;
}

/** WHAT: Checks a Codex observation against the requested selection. WHY: Prevents intentional Sol changes from being treated as involuntary downgrades. */
export function isExpectedCodexModel(state, name, pane, configured, observed) {
  const requested = codexModelOverride(state, name, pane) || configured;
  return /codex/i.test(configured?.cmd || "") && observed?.model === requested?.model;
}

/** WHAT: Stores one validated model and effort atomically. WHY: Keeps account transitions from overwriting another pane's model choice. */
export function setCodexModelOverride(state, name, pane, model, effort = null) {
  if (!/^[a-z0-9._-]+$/i.test(String(model || ""))) throw new Error(`invalid Codex model: ${model}`);
  const normalizedEffort = effort == null ? null : String(effort).toLowerCase();
  if (normalizedEffort && !/^(minimal|low|medium|high|xhigh|max|ultra)$/.test(normalizedEffort)) {
    throw new Error(`invalid Codex reasoning effort: ${effort}`);
  }
  return updatePaneMap(state, CODEX_MODEL_STATE_KEY, models => {
    models[codexPaneKey(name, pane)] = { model: String(model), effort: normalizedEffort };
    return models;
  });
}

/** WHAT: Stores the model map with only the named override cleared. WHY: Prevents rollback from deleting another writer's model selection. */
export function clearCodexModelOverride(state, name, pane) {
  return updatePaneMap(state, CODEX_MODEL_STATE_KEY, models => {
    delete models[codexPaneKey(name, pane)];
    return models;
  });
}

export function isCodexProfileAuthenticated(profile) {
  const authPath = join(profile.home, "auth.json");
  if (!existsSync(authPath)) return false;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    return Boolean(auth && typeof auth === "object" && (auth.tokens || auth.OPENAI_API_KEY));
  } catch {
    return false;
  }
}

function linkSharedDirectory(sourceHome, targetHome, name) {
  const source = join(sourceHome, name);
  const target = join(targetHome, name);
  if (!existsSync(source) || existsSync(target)) return;
  symlinkSync(source, target, "dir");
}

export function ensureCodexExecutionSafety(profile) {
  const rulesDir = join(profile.home, "rules");
  const rulesPath = join(rulesDir, "agentmux-execution-safety.rules");
  mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
  let current = null;
  try { current = readFileSync(rulesPath, "utf8"); } catch { /* first install */ }
  if (current !== CODEX_EXTERNAL_NAVIGATION_RULES) {
    writeFileSync(rulesPath, CODEX_EXTERNAL_NAVIGATION_RULES, { mode: 0o600 });
  }
  return rulesPath;
}

/**
 * Prepare a secondary profile without ever copying auth.json.  Static user
 * extensions are shared; config.toml is copied once so model defaults and
 * later writes stay account-local.
 */
export function prepareCodexProfile(profile, primary = codexProfileCatalog()[0]) {
  mkdirSync(profile.home, { recursive: true, mode: 0o700 });
  ensureCodexExecutionSafety(profile);
  if (profile.primary || profile.home === primary.home) return profile;

  const sourceConfig = join(primary.home, "config.toml");
  const targetConfig = join(profile.home, "config.toml");
  if (existsSync(sourceConfig) && !existsSync(targetConfig)) {
    copyFileSync(sourceConfig, targetConfig);
  }
  for (const name of ["skills", "plugins"]) linkSharedDirectory(primary.home, profile.home, name);
  return profile;
}

export function codexLoginCommand(profile) {
  const quoted = `'${String(profile.home).replace(/'/g, `'\\''`)}'`;
  return `CODEX_HOME=${quoted} codex login --device-auth`;
}

/** Every account home is a possible rollout source for jsonl readers. */
export function codexSessionDirs(env = process.env) {
  return codexProfileCatalog(env).map((profile) => join(profile.home, "sessions"));
}

/** Test/debug helper without exposing credential contents. */
export function codexProfileSummary(profile) {
  let authMode = "missing";
  try {
    const path = join(profile.home, "auth.json");
    const stat = lstatSync(path);
    authMode = stat.isFile() && isCodexProfileAuthenticated(profile) ? "ready" : "invalid";
  } catch { /* missing */ }
  return { id: profile.id, home: profile.home, auth: authMode };
}
