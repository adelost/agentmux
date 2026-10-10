// Shared subscription-quota snapshot for every configured coding-client
// profile. Provider credentials stay in their own profile homes.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_OAUTH_BETA,
  CLAUDE_QUOTA_SOURCE,
  CLAUDE_USAGE_URL,
  normalizeClaudeUsage,
  readClaudeProfileIdentity,
  readClaudeQuota,
} from "./claude-account-quota.mjs";
import { readClaudeQuotaBudgeted } from "./claude-quota-budget.mjs";
import { readCodexAccountQuota } from "./codex-account-quota.mjs";
import { readKimiAccountQuota } from "./kimi-account-quota.mjs";
import { readTailWindow } from "./jsonl-reader.mjs";
import {
  clampQuotaPercent,
  quotaObservation,
  QUOTA_OBSERVATION_SCHEMA_VERSION,
  QUOTA_REFRESH_INTERVAL_MS,
} from "./quota-observation.mjs";
import { quotaAccountCatalog } from "./quota-profiles.mjs";

export {
  CLAUDE_OAUTH_BETA,
  CLAUDE_QUOTA_SOURCE,
  CLAUDE_USAGE_URL,
  normalizeClaudeUsage,
  QUOTA_OBSERVATION_SCHEMA_VERSION,
  QUOTA_REFRESH_INTERVAL_MS,
  readClaudeQuota,
};
export const CODEX_TAIL_BYTES = 256 * 1024;
export const CODEX_SCAN_FILES = 12;
/** WHAT: Names Codex quota provenance. WHY: Keeps rollout events distinct from push receipt time. */
export const CODEX_QUOTA_SOURCE = "codex.rollout.rate_limits";

// ---------- Codex ----------

/** WHAT: Parses Codex rollout fallback events. WHY: Keeps torn JSONL rows from becoming quota truth. */
export function parseCodexRateLimitEvents(text) {
  const events = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.includes('"rate_limits"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // partial tail line or unrelated content
    }
    const rateLimits = parsed?.payload?.rate_limits;
    if (!rateLimits || typeof rateLimits !== "object") continue;
    const windows = ["primary", "secondary"].flatMap((windowId) => {
      const window = rateLimits[windowId];
      const usedPercent = clampQuotaPercent(window?.used_percent);
      if (usedPercent === null) return [];
      return [{
        id: windowId,
        usedPercent,
        windowMinutes: Number.isFinite(window.window_minutes) ? window.window_minutes : null,
        resetsAt: Number.isFinite(window.resets_at)
          ? new Date(window.resets_at * 1000).toISOString()
          : null,
      }];
    });
    if (windows.length === 0) continue;
    events.push({
      capturedAt: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
      limitId: typeof rateLimits.limit_id === "string" ? rateLimits.limit_id : "codex",
      planType: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : null,
      windows,
    });
  }
  return events;
}

function listRolloutFilesMostActiveFirst(sessionsRoot) {
  let entries;
  try {
    entries = readdirSync(sessionsRoot, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile()
      && entry.name.startsWith("rollout-")
      && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .flatMap((path) => {
      try {
        const activityMs = statSync(path).mtimeMs;
        return Number.isFinite(activityMs) ? [{ path, activityMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((left, right) => right.activityMs - left.activityMs
      || right.path.localeCompare(left.path))
    .map((entry) => entry.path);
}

export function readCodexQuota({
  sessionsRoot = join(homedir(), ".codex", "sessions"),
  maxFiles = CODEX_SCAN_FILES,
  tailBytes = CODEX_TAIL_BYTES,
} = {}) {
  // A rollout name records when the session started, not when it last emitted
  // a provider event. Bound IO by actual file activity, then choose by the
  // event's own provider timestamp after parsing the selected tails.
  const files = listRolloutFilesMostActiveFirst(sessionsRoot).slice(0, maxFiles);
  if (files.length === 0) {
    return { ok: false, engine: "codex", error: "no_session_files" };
  }
  const latestByLimit = new Map();
  for (const file of files) {
    let tail;
    try {
      tail = readTailWindow(file, tailBytes).text;
    } catch {
      continue;
    }
    for (const event of parseCodexRateLimitEvents(tail)) {
      if (!Number.isFinite(Date.parse(String(event.capturedAt || "")))) continue;
      const existing = latestByLimit.get(event.limitId);
      if (!existing || Date.parse(event.capturedAt) > Date.parse(existing.capturedAt)) {
        latestByLimit.set(event.limitId, event);
      }
    }
  }
  if (latestByLimit.size === 0) {
    return { ok: false, engine: "codex", error: "no_rate_limit_events" };
  }
  const limits = [...latestByLimit.values()]
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  const newest = limits[0];
  const headline = newest.windows.find((window) => window.windowMinutes === 10_080)
    ?? newest.windows[0];
  return {
    ok: true,
    engine: "codex",
    observation: quotaObservation({ source: CODEX_QUOTA_SOURCE,
      observedAt: newest.capturedAt, usedPercent: headline.usedPercent, resetsAt: headline.resetsAt }),
    limits,
  };
}

// ---------- Snapshot ----------

const collectorFor = (provider, readers) => {
  if (provider === "codex") return readers.codex;
  if (provider === "claude") return readers.claude;
  return readers.kimi;
};

const collectProfile = async (profile, options, readers, now) => {
  const reader = collectorFor(profile.provider, readers);
  try {
    if (profile.provider === "claude") {
      return await reader({ profile, credentialsPath: profile.credentialsPath,
        ...(options.claude ?? {}), now });
    }
    return await reader(profile, { ...(options[profile.provider] ?? {}), now });
  } catch {
    return { ok: false, engine: profile.provider, provider: profile.provider,
      profile: { id: profile.id, key: profile.key, label: profile.label, source: profile.source },
      error: "collector_failed" };
  }
};

// Logins of one account, keyed by the email Claude Code stored at login.
const claudeAccountGroups = (profiles, identityOf) => {
  const groups = new Map();
  for (const profile of profiles) {
    const email = identityOf(profile)?.email?.toLowerCase();
    const key = email ? `email:${email}` : `profile:${profile.key}`;
    groups.set(key, [...(groups.get(key) || []), profile]);
  }
  return [...groups.values()];
};

// Refused before reaching the usage endpoint: another login of the same account may answer.
const TRY_NEXT_LOGIN = new Set([
  "credentials_unavailable", "credentials_expired", "login_expired", "login_required", "refresh_busy",
]);

const asAccount = (result, members, identity) => ({
  ...result,
  account: result.account ?? { email: identity?.email ?? null,
    organization: identity?.organization ?? null, plan: null },
  sharedBy: members.map((member) => ({ id: member.id, key: member.key, source: member.source })),
});

/** WHAT: Reads one Claude account through the first of its logins that answers. WHY: Keeps one line and one usage call per account. */
const collectClaudeAccount = async (members, options, readers, now, identityOf) => {
  let first = null;
  for (const profile of members) {
    const result = await collectProfile(profile, options, readers, now);
    first ??= result;
    if (result.ok || !TRY_NEXT_LOGIN.has(result.error)) {
      return asAccount(result, members, identityOf(profile));
    }
  }
  return asAccount(first, members, identityOf(members[0]));
};

const providerHeadline = (accounts, provider) =>
  accounts.find((account) => account.provider === provider && account.ok)
  ?? accounts.find((account) => account.provider === provider)
  ?? { ok: false, engine: provider, provider, error: "profile_missing" };

/**
 * WHAT: Collects every coding-subscription profile, and each Claude account once.
 * WHY: Keeps all clients on one account snapshot, including Claude logins that are in no launch slot.
 */
export async function readQuotaSnapshot({
  claude,
  codex,
  kimi,
  profiles = quotaAccountCatalog(),
  readers = {
    claude: readClaudeQuotaBudgeted,
    codex: readCodexAccountQuota,
    kimi: readKimiAccountQuota,
  },
  identityOf = readClaudeProfileIdentity,
  now = Date.now,
} = {}) {
  const options = { claude, codex, kimi };
  const ofProvider = (provider) => profiles.filter((profile) => profile.provider === provider);
  const collectAll = (provider) => Promise.all(ofProvider(provider).map((profile) =>
    collectProfile(profile, options, readers, now)));
  const [codexAccounts, claudeAccounts, kimiAccounts] = await Promise.all([
    collectAll("codex"),
    Promise.all(claudeAccountGroups(ofProvider("claude"), identityOf).map((members) =>
      collectClaudeAccount(members, options, readers, now, identityOf))),
    collectAll("kimi"),
  ]);
  const accounts = [...codexAccounts, ...claudeAccounts, ...kimiAccounts];
  return {
    schemaVersion: 2,
    generatedAt: new Date(now()).toISOString(),
    accounts,
    claude: providerHeadline(accounts, "claude"),
    codex: providerHeadline(accounts, "codex"),
    kimi: providerHeadline(accounts, "kimi"),
  };
}
