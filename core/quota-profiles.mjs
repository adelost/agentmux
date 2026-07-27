// Provider-owned login profiles used by the quota dashboard.
//
// Only paths and operator labels live here. Tokens remain in Codex, Claude
// Code and Gemini/Antigravity's own homes.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PROVIDERS = Object.freeze(["codex", "claude", "gemini"]);

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
    .map((entry) => join(usersRoot, entry.name, `.${provider}`))
    .filter((path) => exists(path))
    .sort();
  return candidates.length === 1 ? candidates[0] : null;
};

const envPrefix = (provider, id) => `AMUX_${provider.toUpperCase()}_PROFILE_${id}`;

const profile = (provider, id, home, env, source) => {
  const prefix = envPrefix(provider, id);
  const resolvedHome = resolve(env[`${prefix}_HOME`] || home);
  const label = String(env[`${prefix}_LABEL`] || `${provider} ${id}`).trim();
  const base = { provider, id: String(id), key: `${provider}:${id}`,
    label, home: resolvedHome, source };
  if (provider === "codex") return { ...base, credentialsPath: join(resolvedHome, "auth.json") };
  if (provider === "gemini") {
    return { ...base, credentialsPath: join(resolvedHome, "oauth_creds.json"),
      identityPath: join(resolvedHome, "google_accounts.json") };
  }
  const defaultIdentity = source === "windows"
    ? join(dirname(resolvedHome), ".claude.json")
    : id === 1 ? join(resolve(env.HOME || homedir()), ".claude.json")
      : join(resolvedHome, ".claude.json");
  return { ...base, credentialsPath: join(resolvedHome, ".credentials.json"),
    identityPath: defaultIdentity };
};

/** WHAT: Builds the coding-client profile catalog. WHY: Keeps credentials in provider-owned homes. */
export function quotaProfileCatalog(env = process.env, options = {}) {
  const home = resolve(env.HOME || homedir());
  const roots = resolve(env.AMUX_ACCOUNT_PROFILES_DIR
    || join(home, ".config", "agent", "account-profiles"));
  const windows = Object.fromEntries(PROVIDERS.map((provider) =>
    [provider, windowsProviderHome(provider, options)]));
  return [
    profile("codex", 1, join(home, ".codex"), env, "primary"),
    profile("codex", 2, join(home, ".config", "agent", "codex-profiles", "2"), env, "isolated"),
    profile("claude", 1, join(home, ".claude"), env, "primary"),
    profile("claude", 2, windows.claude || join(roots, "claude", "2"), env,
      windows.claude ? "windows" : "isolated"),
    profile("gemini", 1, join(home, ".gemini"), env, "primary"),
    profile("gemini", 2, windows.gemini || join(roots, "gemini", "2"), env,
      windows.gemini ? "windows" : "isolated"),
  ];
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
    return `CLAUDE_CONFIG_DIR=${shellQuote(item.home)} claude auth login`;
  }
  return `GEMINI_CLI_HOME=${shellQuote(item.home)} gemini`;
}
