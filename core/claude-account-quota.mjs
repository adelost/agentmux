// Claude Code subscription quota for one provider-owned config profile.
//
// Access/refresh tokens never leave the profile. Expired OAuth credentials are
// refreshed once through Claude Code's public OAuth client and written back
// atomically to the same credential file.

import {
  chmodSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { clampQuotaPercent, quotaObservation } from "./quota-observation.mjs";

/** WHAT: Names Claude's usage endpoint. WHY: Keeps collection separate from API billing. */
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** WHAT: Names Claude's refresh endpoint. WHY: Keeps refresh inside the provider profile. */
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** WHAT: Defines Claude Code's public client. WHY: Keeps refresh aligned with the installed client. */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** WHAT: Defines Claude's OAuth usage contract. WHY: Keeps requests on the coding-subscription surface. */
export const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
/** WHAT: Defines Claude observation provenance. WHY: Keeps source provenance visible in clients. */
export const CLAUDE_QUOTA_SOURCE = "anthropic.oauth.usage";

const typedFailure = (error, profile = null) => ({
  ok: false,
  engine: "claude",
  ...(profile ? { provider: "claude", profile: {
    id: profile.id, key: profile.key, label: profile.label, source: profile.source,
  } } : {}),
  error,
});

const profileIdentity = (profile) => {
  if (!profile?.identityPath) return { email: null, organization: null };
  try {
    const account = JSON.parse(readFileSync(profile.identityPath, "utf8"))?.oauthAccount;
    return {
      email: typeof account?.emailAddress === "string" ? account.emailAddress : null,
      organization: typeof account?.organizationName === "string" ? account.organizationName : null,
    };
  } catch {
    return { email: null, organization: null };
  }
};

/** WHAT: Normalizes Claude limits. WHY: Keeps raw OAuth payloads out of shared consumers. */
export function normalizeClaudeUsage(payload, fetchedAt, profile = null, credentials = null) {
  const rows = Array.isArray(payload?.limits) ? payload.limits : [];
  const limits = rows
    .map((row) => {
      const scopeName = row?.scope?.model?.display_name || null;
      const kind = String(row?.kind || "unknown");
      return {
        id: kind === "weekly_scoped" && scopeName
          ? `weekly_${scopeName.toLowerCase().replace(/[^a-z0-9]+/gu, "_")}`
          : kind,
        kind,
        scopeName,
        usedPercent: clampQuotaPercent(row?.percent),
        resetsAt: typeof row?.resets_at === "string" ? row.resets_at : null,
        severity: typeof row?.severity === "string" ? row.severity : null,
        isActive: row?.is_active === true,
      };
    })
    .filter((limit) => limit.usedPercent !== null);
  if (limits.length === 0) {
    return { ...typedFailure("no_limits_in_response", profile), fetchedAt };
  }
  const headline = limits.find((limit) => limit.kind === "weekly_scoped"
    && limit.scopeName === "Fable")
    ?? limits.find((limit) => limit.kind === "weekly_all")
    ?? limits[0];
  const identity = profileIdentity(profile);
  return {
    ok: true,
    engine: "claude",
    provider: "claude",
    ...(profile ? { profile: {
      id: profile.id, key: profile.key, label: profile.label, source: profile.source,
    } } : {}),
    account: {
      email: identity.email,
      organization: identity.organization,
      plan: credentials?.subscriptionType || null,
    },
    fetchedAt,
    observation: quotaObservation({ source: CLAUDE_QUOTA_SOURCE,
      observedAt: fetchedAt, usedPercent: headline.usedPercent, resetsAt: headline.resetsAt }),
    limits,
  };
}

const writeCredentialsAtomic = (credentialsPath, document) => {
  const temp = join(dirname(credentialsPath), `.credentials.agentmux.${process.pid}.${Date.now()}.json`);
  try {
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, credentialsPath);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
};

/** WHAT: Saves one refreshed Claude token. WHY: Keeps expired tokens from becoming silent stale data. */
export async function refreshClaudeCredentials(document, {
  credentialsPath,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  now = Date.now,
  persist = writeCredentialsAtomic,
} = {}) {
  const oauth = document?.claudeAiOauth;
  if (!oauth?.refreshToken) return { ok: false, error: "login_required" };
  let response;
  try {
    response = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oauth.refreshToken,
        client_id: CLAUDE_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, error: "network_error" };
  }
  if (!response.ok) {
    return { ok: false, error: response.status === 400 || response.status === 401
      ? "login_required" : `refresh_http_${response.status}` };
  }
  let payload;
  try { payload = await response.json(); }
  catch { return { ok: false, error: "refresh_invalid_response" }; }
  if (typeof payload?.access_token !== "string" || !payload.access_token) {
    return { ok: false, error: "refresh_invalid_response" };
  }
  const expiresIn = Number(payload.expires_in);
  const refreshed = {
    ...document,
    claudeAiOauth: {
      ...oauth,
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token || oauth.refreshToken,
      expiresAt: Number.isFinite(expiresIn) ? now() + expiresIn * 1000 : oauth.expiresAt,
    },
  };
  if (credentialsPath && persist) persist(credentialsPath, refreshed);
  return { ok: true, document: refreshed };
}

/** WHAT: Reads one Claude subscription profile. WHY: Keeps account identity attached to its limits. */
export async function readClaudeQuota({
  profile = null,
  credentialsPath = profile?.credentialsPath,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  now = Date.now,
  refresh = true,
  persist,
} = {}) {
  let document;
  try { document = JSON.parse(readFileSync(credentialsPath, "utf8")); }
  catch { return typedFailure("credentials_unavailable", profile); }
  let credentials = document?.claudeAiOauth;
  if (!credentials?.accessToken) return typedFailure("credentials_unavailable", profile);
  if (Number.isFinite(credentials.expiresAt) && credentials.expiresAt <= now()) {
    if (!refresh) return typedFailure("credentials_expired", profile);
    const refreshed = await refreshClaudeCredentials(document, {
      credentialsPath, fetchImpl, timeoutMs, now, ...(persist ? { persist } : {}),
    });
    if (!refreshed.ok) return typedFailure(refreshed.error, profile);
    document = refreshed.document;
    credentials = document.claudeAiOauth;
  }

  let response;
  try {
    response = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": CLAUDE_OAUTH_BETA,
        "user-agent": "claude-code/2.1",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return typedFailure("network_error", profile);
  }
  if (!response.ok) {
    const error = response.status === 401 && profile ? "login_required" : `http_${response.status}`;
    return typedFailure(error, profile);
  }
  let payload;
  try { payload = await response.json(); }
  catch { return typedFailure("invalid_response", profile); }
  return normalizeClaudeUsage(payload, new Date(now()).toISOString(), profile, credentials);
}
