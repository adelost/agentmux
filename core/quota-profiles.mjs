// Provider-owned login profiles used by the quota dashboard.
//
// Only paths and operator labels live here. Tokens remain in Codex, Claude
// Code and Kimi Code's own homes.

import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROVIDERS = Object.freeze(["codex", "claude", "kimi"]);

const providerDirectory = (provider) =>
  provider === "kimi" ? ".kimi-code" : `.${provider}`;

const windowsProviderHome = (provider, {
  usersRoot = "/mnt/c/Users",
  exists = existsSync,
  readDir = readdirSync,
} = {}) => {
  let users;
  try { users = readDir(usersRoot, { withFileTypes: true }); }
  catch { return null; }
  const candidates = users
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(usersRoot, entry.name, providerDirectory(provider)))
    .filter((path) => exists(path))
    .sort();
  return candidates.length === 1 ? candidates[0] : null;
};

const envPrefix = (provider, id) => `AMUX_${provider.toUpperCase()}_PROFILE_${id}`;

const readProfileFile = (env, home, readFile) => {
  const path = resolve(env.AMUX_ACCOUNT_LABELS_FILE
    || join(home, ".agentmux", "account-profiles.json"));
  try { return JSON.parse(readFile(path, "utf8")); }
  catch { return null; }
};

// Version 1 labelled each slot, and the labels drifted from the login a slot runs (codex:1 said
// wetterlind while it ran adelost, 2026-10-17). Version 2 keeps only slot homes; logins have entries.
const slotEntries = (document) => (document?.version === 2 ? document.slots
  : document?.version === 1 ? document.profiles : null);

const readOperatorProfiles = (env, home, readFile) => {
  try {
    const slots = slotEntries(readProfileFile(env, home, readFile));
    if (!slots || typeof slots !== "object" || Array.isArray(slots)) return {};
    return Object.fromEntries(Object.entries(slots).flatMap(([key, value]) => {
      const label = typeof value?.label === "string" ? value.label.trim() : "";
      const profileHome = typeof value?.home === "string" ? value.home.trim() : "";
      if ((!label || label.length > 254) && !profileHome) return [];
      return [[key.toLowerCase(), {
        ...(label && label.length <= 254 ? { label } : {}),
        ...(profileHome ? { home: resolve(profileHome) } : {}),
      }]];
    }));
  } catch {
    return {};
  }
};

const profile = (provider, id, home, env, source, operatorProfiles) => {
  const prefix = envPrefix(provider, id);
  const key = `${provider}:${id}`;
  const operator = operatorProfiles[key] || {};
  const resolvedHome = resolve(env[`${prefix}_HOME`] || operator.home || home);
  const resolvedSource = env[`${prefix}_HOME`] ? "env"
    : operator.home ? "configured"
      : source;
  const label = String(env[`${prefix}_LABEL`] || operator.label || `${provider} ${id}`).trim();
  const base = { provider, id: String(id), key: `${provider}:${id}`,
    label, home: resolvedHome, source: resolvedSource };
  if (provider === "codex") return { ...base, credentialsPath: join(resolvedHome, "auth.json") };
  if (provider === "kimi") {
    return { ...base, credentialsPath: join(resolvedHome, "credentials", "kimi-code.json"),
      configPath: join(resolvedHome, "config.toml") };
  }
  const defaultIdentity = resolvedSource === "windows"
    ? join(dirname(resolvedHome), ".claude.json")
    : id === 1 ? join(resolve(env.HOME || homedir()), ".claude.json")
      : join(resolvedHome, ".claude.json");
  return { ...base, credentialsPath: join(resolvedHome, ".credentials.json"),
    identityPath: defaultIdentity };
};

const accountProfilesRoot = (env, home) => resolve(env.AMUX_ACCOUNT_PROFILES_DIR
  || join(home, ".config", "agent", "account-profiles"));

/** WHAT: Builds the coding-client profile catalog. WHY: Keeps credentials in provider-owned homes. */
export function quotaProfileCatalog(env = process.env, options = {}) {
  const home = resolve(env.HOME || homedir());
  const roots = accountProfilesRoot(env, home);
  const operatorProfiles = readOperatorProfiles(env, home, options.readFile || readFileSync);
  const windows = Object.fromEntries(PROVIDERS.map((provider) =>
    [provider, windowsProviderHome(provider, options)]));
  return [
    profile("codex", 1, join(home, ".codex"), env, "primary", operatorProfiles),
    profile("codex", 2, join(home, ".config", "agent", "codex-profiles", "2"), env, "isolated", operatorProfiles),
    profile("claude", 1, join(home, ".claude"), env, "primary", operatorProfiles),
    profile("claude", 2, windows.claude || join(roots, "claude", "2"), env,
      windows.claude ? "windows" : "isolated", operatorProfiles),
    profile("kimi", 1, join(home, ".kimi-code"), env, "primary", operatorProfiles),
    profile("kimi", 2, windows.kimi || join(roots, "kimi", "2"), env,
      windows.kimi ? "windows" : "isolated", operatorProfiles),
  ];
}

const holdsClaudeLogin = (home, readFile) => {
  try { return Boolean(JSON.parse(readFile(join(home, ".credentials.json"), "utf8"))?.claudeAiOauth); }
  catch { return false; }
};

const claudeLoginProfile = (name, home) => ({
  provider: "claude", id: name, key: `claude:login:${name}`, label: name, home, source: "login",
  credentialsPath: join(home, ".credentials.json"), identityPath: join(home, ".claude.json"),
});

/**
 * WHAT: Returns every Claude login dir that no launch slot already uses.
 * WHY: Keeps one login in one dir, whether it is read for quota or selected for a pane.
 */
export function claudeLoginProfiles(env = process.env, options = {}, slots = quotaProfileCatalog(env, options)) {
  const { readDir = readdirSync, readFile = readFileSync, realpath = realpathSync } = options;
  const canonical = (path) => { try { return realpath(path); } catch { return resolve(path); } };
  const slotHomes = new Set(slots.filter((profile) => profile.provider === "claude")
    .map((profile) => canonical(profile.home)));
  const root = join(accountProfilesRoot(env, resolve(env.HOME || homedir())), "claude");
  let entries;
  try { entries = readDir(root, { withFileTypes: true }); }
  catch { entries = []; }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, home: join(root, entry.name) }))
    .filter(({ home }) => !slotHomes.has(canonical(home)) && holdsClaudeLogin(home, readFile))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(({ name, home }) => claudeLoginProfile(name, home));
}

const LOGIN_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;
const ACCOUNT_KEY = /^(?:codex|claude|kimi):[a-z0-9][a-z0-9._-]{0,63}$/u;
const isDay = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

// Mattias 2026-10-17: the renewal date and the free resets left, read by hand from the billing and usage pages.
// The names are the ones stats.v1d.io reads (api:0, 2026-10-17), so the push forwards them unchanged.
const SUBSCRIPTION_FIELDS = Object.freeze({
  renewsOn: { valid: isDay, need: "YYYY-MM-DD" },
  freeResetsLeft: { valid: (value) => Number.isInteger(value) && value >= 0, need: "a whole number" },
  freeResetsReadOn: { valid: isDay, need: "YYYY-MM-DD" },
});

/** WHAT: Checks one login's subscription fields. WHY: Keeps a free-reset count from standing without the day it was read. */
function subscriptionOf(key, value, problems) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    problems.push(`${key}: subscription needs an object`);
    return null;
  }
  const kept = {};
  for (const [field, rule] of Object.entries(SUBSCRIPTION_FIELDS)) {
    if (value[field] === undefined) continue;
    if (rule.valid(value[field])) kept[field] = value[field];
    else problems.push(`${key}: subscription.${field} needs ${rule.need}`);
  }
  if ((kept.freeResetsLeft === undefined) !== (kept.freeResetsReadOn === undefined)) {
    problems.push(`${key}: subscription.freeResetsLeft and freeResetsReadOn go together`);
    delete kept.freeResetsLeft;
    delete kept.freeResetsReadOn;
  }
  return Object.keys(kept).length ? kept : null;
}

/**
 * WHAT: Reads each login's entry (name, renewal date, free resets) and names every invalid field.
 * WHY: Keeps what only a billing page shows beside its login, and a typo from vanishing silently.
 */
export function accountEntries(env = process.env, options = {}) {
  const document = readProfileFile(env, resolve(env.HOME || homedir()), options.readFile || readFileSync);
  const entries = new Map(), problems = [];
  const accounts = document?.version === 2 ? document.accounts : null;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return { entries, problems };
  for (const [key, value] of Object.entries(accounts)) {
    const id = key.toLowerCase();
    if (!ACCOUNT_KEY.test(id) || !value || typeof value !== "object") {
      problems.push(`${key}: not an engine:login entry`);
      continue;
    }
    const entry = {};
    if (value.name !== undefined) {
      if (typeof value.name === "string" && value.name.trim() && value.name.length <= 40) entry.name = value.name.trim();
      else problems.push(`${key}: name needs at most 40 characters`);
    }
    const subscription = value.subscription === undefined ? null : subscriptionOf(key, value.subscription, problems);
    if (subscription) entry.subscription = subscription;
    entries.set(id, entry);
  }
  return { entries, problems };
}

/** WHAT: Names a new Claude login dir under the account-profiles root. WHY: Keeps a second account in its own dir from its first login. */
export function newClaudeLoginProfile(name, env = process.env) {
  if (!LOGIN_NAME.test(String(name || ""))) return null;
  return claudeLoginProfile(name, join(accountProfilesRoot(env, resolve(env.HOME || homedir())), "claude", name));
}

/**
 * WHAT: Builds the launch slots plus every Claude login dir that is in no slot.
 * WHY: Keeps a subscription's usage visible whether or not a pane runs on it.
 */
export function quotaAccountCatalog(env = process.env, options = {}) {
  const slots = quotaProfileCatalog(env, options);
  return [...slots, ...claudeLoginProfiles(env, options, slots)];
}

/** WHAT: Resolves one profile key. WHY: Keeps operator input bound to declared accounts. */
export function quotaProfile(catalog, key) {
  const normalized = String(key || "").trim().toLowerCase();
  return catalog.find((entry) => entry.key.toLowerCase() === normalized) ?? null;
}

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** WHAT: Builds a profile-scoped login command. WHY: Keeps authentication from changing another account. */
export function profileLoginInstruction(item) {
  if (item.provider === "codex") {
    return `CODEX_HOME=${shellQuote(item.home)} codex login --device-auth`;
  }
  if (item.provider === "claude") {
    if (item.id === "1" && item.source === "primary") return "claude auth login";
    return `CLAUDE_CONFIG_DIR=${shellQuote(item.home)} claude auth login`;
  }
  return `KIMI_CODE_HOME=${shellQuote(item.home)} kimi login`;
}
