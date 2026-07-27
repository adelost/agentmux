// Runtime account selection for coding panes.
//
// OAuth credentials remain in provider-owned profile homes. Claude and Kimi
// secondary profiles share only durable session history with profile 1, so an
// exact resume can survive an account rotation without copying credentials.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  CODEX_PROFILE_STATE_KEY,
  codexPaneKey,
  isCodexProfileAuthenticated,
  prepareCodexProfile,
  setCodexProfile,
} from "./codex-profiles.mjs";
import { quotaProfileCatalog } from "./quota-profiles.mjs";

/** WHAT: Names durable pane-to-profile state. WHY: Keeps runtime selection separate from provider credentials. */
export const ACCOUNT_PROFILE_STATE_KEY = "account_profile_by_pane_v1";
/** WHAT: Names interrupted account transitions. WHY: Keeps a process crash from erasing restart intent. */
export const ACCOUNT_PROFILE_PENDING_STATE_KEY = "account_profile_pending_by_pane_v1";

/** WHAT: Maps a declared command to its coding engine. WHY: Keeps account routing independent from display names. */
export function accountEngineForCommand(command) {
  const value = String(command || "");
  if (/(?:^|[\/\s])kimi(?:-code)?(?:\s|$)/iu.test(value)) return "kimi";
  if (/(?:^|\s)codex(?:\s|$)/iu.test(value)) return "codex";
  if (/(?:^|\s)claude(?:\s|$)/iu.test(value)) return "claude";
  return null;
}

/** WHAT: Returns declared provider profiles. WHY: Keeps quota and runtime on one credential registry. */
export function runtimeProfileCatalog(provider, env = process.env, options = {}) {
  return quotaProfileCatalog(env, options).filter((profile) => profile.provider === provider);
}

const selectedId = (state, agentName, pane, paneConfig, provider) => {
  const key = codexPaneKey(agentName, pane);
  const selected = state?.get?.(ACCOUNT_PROFILE_STATE_KEY, {})?.[key];
  if (selected != null) return String(selected);
  if (paneConfig?.accountProfile != null) return String(paneConfig.accountProfile);
  if (provider === "codex") {
    const legacy = state?.get?.(CODEX_PROFILE_STATE_KEY, {})?.[key];
    if (legacy != null) return String(legacy);
  }
  return "1";
};

/** WHAT: Resolves one pane's account profile. WHY: Keeps config, state, launch, and readers on one selection. */
export function selectedRuntimeProfile({
  state,
  agentName,
  pane,
  paneConfig,
  provider = accountEngineForCommand(paneConfig?.cmd),
  catalog = runtimeProfileCatalog(provider),
} = {}) {
  const id = selectedId(state, agentName, pane, paneConfig, provider);
  return catalog.find((profile) => profile.id === id) || catalog[0] || null;
}

/** WHAT: Resolves an explicit profile id. WHY: Prevents undeclared account switches from reaching process changes. */
export function resolveRuntimeProfile(provider, requested, catalog = runtimeProfileCatalog(provider)) {
  const id = String(requested || "").trim();
  return catalog.find((profile) => profile.id === id) || null;
}

/** WHAT: Stores a pane selection. WHY: Keeps bridge and standalone CLI aligned across restarts. */
export function setRuntimeProfile(state, agentName, pane, provider, profileId) {
  if (!state?.set) throw new Error("account profile state is unavailable");
  const key = codexPaneKey(agentName, pane);
  const profiles = { ...(state.get(ACCOUNT_PROFILE_STATE_KEY, {}) || {}) };
  profiles[key] = String(profileId);
  state.set(ACCOUNT_PROFILE_STATE_KEY, profiles);
  if (provider === "codex") setCodexProfile(state, agentName, pane, profileId);
  return profiles;
}

/** WHAT: Reads one interrupted profile transition. WHY: Keeps retries bound to the original pane and session. */
export function pendingRuntimeProfile(state, agentName, pane) {
  return state?.get?.(ACCOUNT_PROFILE_PENDING_STATE_KEY, {})?.[codexPaneKey(agentName, pane)] || null;
}

/** WHAT: Stores restart intent before process replacement. WHY: Prevents a crash from making an account transition untraceable. */
export function beginRuntimeProfileTransition(state, {
  agentName,
  pane,
  provider,
  previousProfileId,
  targetProfileId,
  sessionId,
}) {
  if (!state?.set || !sessionId) throw new Error("account transition state is unavailable");
  const key = codexPaneKey(agentName, pane);
  const pending = { ...(state.get(ACCOUNT_PROFILE_PENDING_STATE_KEY, {}) || {}) };
  pending[key] = {
    version: 1,
    agentName: String(agentName),
    pane: Number(pane),
    provider,
    previousProfileId: String(previousProfileId),
    targetProfileId: String(targetProfileId),
    sessionId: String(sessionId),
    startedAt: Date.now(),
  };
  state.set(ACCOUNT_PROFILE_PENDING_STATE_KEY, pending);
  return pending[key];
}

function clearRuntimeProfileTransition(state, agentName, pane) {
  const key = codexPaneKey(agentName, pane);
  const pending = { ...(state.get(ACCOUNT_PROFILE_PENDING_STATE_KEY, {}) || {}) };
  delete pending[key];
  state.set(ACCOUNT_PROFILE_PENDING_STATE_KEY, pending);
}

/** WHAT: Stores a completed target selection and clears restart intent. WHY: Keeps future wakes on the verified live account. */
export function completeRuntimeProfileTransition(state, transition, profileId) {
  setRuntimeProfile(
    state,
    transition.agentName,
    transition.pane,
    transition.provider,
    profileId,
  );
  clearRuntimeProfileTransition(state, transition.agentName, transition.pane);
}

/** WHAT: Reads provider-owned credential presence. WHY: Prevents restart into a profile that cannot authenticate. */
export function runtimeProfileAuthenticated(profile) {
  if (!profile) return false;
  if (profile.provider === "codex") return isCodexProfileAuthenticated(profile);
  try {
    const credentials = JSON.parse(readFileSync(profile.credentialsPath, "utf8"));
    if (profile.provider === "claude") {
      return Boolean(
        credentials?.claudeAiOauth?.accessToken
        || credentials?.claudeAiOauth?.refreshToken,
      );
    }
    return Boolean(credentials?.access_token || credentials?.refresh_token);
  } catch {
    return false;
  }
}

function ensureSharedEntry(source, target, kind) {
  if (kind === "dir") mkdirSync(source, { recursive: true, mode: 0o700 });
  else {
    mkdirSync(dirname(source), { recursive: true, mode: 0o700 });
    if (!existsSync(source)) writeFileSync(source, "", { mode: 0o600 });
  }
  if (existsSync(target)) {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() && resolve(dirname(target), readlinkSync(target)) === resolve(source)) {
      return;
    }
    throw new Error(`account profile history path already exists: ${target}`);
  }
  symlinkSync(resolve(source), target, kind === "dir" ? "dir" : "file");
}

/** WHAT: Builds shared-history links without copying auth. WHY: Keeps exact resume history shared while OAuth remains isolated. */
export function prepareRuntimeProfile(profile, catalog = runtimeProfileCatalog(profile?.provider)) {
  if (!profile) throw new Error("account profile is required");
  const primary = catalog.find((candidate) => candidate.id === "1") || catalog[0];
  if (profile.provider === "codex") {
    prepareCodexProfile(profile, primary);
    return profile;
  }
  mkdirSync(profile.home, { recursive: true, mode: 0o700 });
  if (!primary || profile.id === primary.id || profile.home === primary.home) return profile;
  mkdirSync(primary.home, { recursive: true, mode: 0o700 });
  if (profile.provider === "claude") {
    ensureSharedEntry(join(primary.home, "projects"), join(profile.home, "projects"), "dir");
  } else if (profile.provider === "kimi") {
    ensureSharedEntry(join(primary.home, "sessions"), join(profile.home, "sessions"), "dir");
    ensureSharedEntry(
      join(primary.home, "session_index.jsonl"),
      join(profile.home, "session_index.jsonl"),
      "file",
    );
  }
  return profile;
}

/** WHAT: Builds journal options for a profile. WHY: Lets exact-session probes stay provider scoped when needed. */
export function runtimeJournalOptions(profile) {
  if (profile?.provider === "claude") return { profileHome: profile.home };
  if (profile?.provider === "kimi") {
    return { env: { ...process.env, KIMI_CODE_HOME: profile.home } };
  }
  if (profile?.provider === "codex") return { sessionDirs: [join(profile.home, "sessions")] };
  return {};
}

/** WHAT: Builds one config/state-backed runtime resolver. WHY: Keeps lifecycle files free from profile-registry policy. */
export function createRuntimeProfileResolver({
  state,
  configFor,
  catalogFor = runtimeProfileCatalog,
} = {}) {
  return (agentName, pane, provider) => {
    const catalog = catalogFor(provider);
    const paneConfig = configFor(agentName).panes?.[pane];
    const profile = selectedRuntimeProfile({
      state,
      agentName,
      pane,
      paneConfig,
      provider,
      catalog,
    });
    if (!profile) throw new Error(`No ${provider} account profile is configured`);
    return prepareRuntimeProfile(profile, catalog);
  };
}
