// Provider-owned login profiles used by the quota dashboard.
//
// Only paths and operator labels live here. Tokens remain in Codex, Claude
// Code and Kimi Code's own homes.

import { existsSync, readFileSync, readdirSync } from "node:fs";
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

const readOperatorProfiles = (env, home, readFile) => {
  const path = resolve(env.AMUX_ACCOUNT_LABELS_FILE
    || join(home, ".agentmux", "account-profiles.json"));
  try {
    const document = JSON.parse(readFile(path, "utf8"));
    if (document?.version !== 1 || !document.profiles
      || typeof document.profiles !== "object" || Array.isArray(document.profiles)) return {};
    return Object.fromEntries(Object.entries(document.profiles).flatMap(([key, value]) => {
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

/** WHAT: Builds the coding-client profile catalog. WHY: Keeps credentials in provider-owned homes. */
export function quotaProfileCatalog(env = process.env, options = {}) {
  const home = resolve(env.HOME || homedir());
  const roots = resolve(env.AMUX_ACCOUNT_PROFILES_DIR
    || join(home, ".config", "agent", "account-profiles"));
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
