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
} from "fs";
import { join, resolve } from "path";

export const CODEX_PROFILE_STATE_KEY = "codex_profile_by_pane";
export const CODEX_MODEL_STATE_KEY = "codex_model_by_pane";

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

export function setCodexProfile(state, name, pane, profileId) {
  const profiles = { ...(state?.get?.(CODEX_PROFILE_STATE_KEY, {}) || {}) };
  profiles[codexPaneKey(name, pane)] = String(profileId);
  state.set(CODEX_PROFILE_STATE_KEY, profiles);
  return profiles;
}

export function codexModelOverride(state, name, pane) {
  const value = state?.get?.(CODEX_MODEL_STATE_KEY, {})?.[codexPaneKey(name, pane)];
  if (!value || !/^[a-z0-9._-]+$/i.test(String(value.model || ""))) return null;
  const effort = value.effort == null ? null : String(value.effort).toLowerCase();
  if (effort && !/^(minimal|low|medium|high|xhigh|max|ultra)$/.test(effort)) return null;
  return { model: String(value.model), effort };
}

export function setCodexModelOverride(state, name, pane, model, effort = null) {
  if (!/^[a-z0-9._-]+$/i.test(String(model || ""))) throw new Error(`invalid Codex model: ${model}`);
  const normalizedEffort = effort == null ? null : String(effort).toLowerCase();
  if (normalizedEffort && !/^(minimal|low|medium|high|xhigh|max|ultra)$/.test(normalizedEffort)) {
    throw new Error(`invalid Codex reasoning effort: ${effort}`);
  }
  const models = { ...(state?.get?.(CODEX_MODEL_STATE_KEY, {}) || {}) };
  models[codexPaneKey(name, pane)] = { model: String(model), effort: normalizedEffort };
  state.set(CODEX_MODEL_STATE_KEY, models);
  return models;
}

export function clearCodexModelOverride(state, name, pane) {
  const models = { ...(state?.get?.(CODEX_MODEL_STATE_KEY, {}) || {}) };
  delete models[codexPaneKey(name, pane)];
  state.set(CODEX_MODEL_STATE_KEY, models);
  return models;
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

/**
 * Prepare a secondary profile without ever copying auth.json.  Static user
 * extensions are shared; config.toml is copied once so model defaults and
 * later writes stay account-local.
 */
export function prepareCodexProfile(profile, primary = codexProfileCatalog()[0]) {
  mkdirSync(profile.home, { recursive: true, mode: 0o700 });
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
