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

const readOperatorLabels = (env, home, readFile) => {
  const path = resolve(env.AMUX_ACCOUNT_LABELS_FILE
    || join(home, ".agentmux", "account-profiles.json"));
  try {
    const document = JSON.parse(readFile(path, "utf8"));
    if (document?.version !== 1 || !document.profiles
      || typeof document.profiles !== "object" || Array.isArray(document.profiles)) return {};
    return Object.fromEntries(Object.entries(document.profiles).flatMap(([key, value]) => {
      const label = typeof value?.label === "string" ? value.label.trim() : "";
      return label && label.length <= 254 ? [[key.toLowerCase(), label]] : [];
    }));
  } catch {
    return {};
  }
};

const profile = (provider, id, home, env, source, labels) => {
  const prefix = envPrefix(provider, id);
  const resolvedHome = resolve(env[`${prefix}_HOME`] || home);
  const key = `${provider}:${id}`;
  const label = String(env[`${prefix}_LABEL`] || labels[key] || `${provider} ${id}`).trim();
  const base = { provider, id: String(id), key: `${provider}:${id}`,
    label, home: resolvedHome, source };
  if (provider === "codex") return { ...base, credentialsPath: join(resolvedHome, "auth.json") };
  if (provider === "kimi") {
    return { ...base, credentialsPath: join(resolvedHome, "credentials", "kimi-code.json"),
      configPath: join(resolvedHome, "config.toml") };
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
  const labels = readOperatorLabels(env, home, options.readFile || readFileSync);
  const windows = Object.fromEntries(PROVIDERS.map((provider) =>
    [provider, windowsProviderHome(provider, options)]));
  return [
    profile("codex", 1, join(home, ".codex"), env, "primary", labels),
    profile("codex", 2, join(home, ".config", "agent", "codex-profiles", "2"), env, "isolated", labels),
    profile("claude", 1, join(home, ".claude"), env, "primary", labels),
    profile("claude", 2, windows.claude || join(roots, "claude", "2"), env,
      windows.claude ? "windows" : "isolated", labels),
    profile("kimi", 1, join(home, ".kimi-code"), env, "primary", labels),
    profile("kimi", 2, windows.kimi || join(roots, "kimi", "2"), env,
      windows.kimi ? "windows" : "isolated", labels),
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
  return `KIMI_CODE_HOME=${shellQuote(item.home)} kimi login`;
}
