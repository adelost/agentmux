// Kimi Code subscription quota for one provider-owned OAuth profile.
//
// The collector reads the same profile home as the Kimi CLI and performs one
// bounded GET against its documented usage endpoint. Kimi remains the sole
// owner of login and token refresh; agentmux never writes credentials.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { clampQuotaPercent, quotaObservation } from "./quota-observation.mjs";

/** WHAT: Names Kimi Code's subscription usage endpoint. WHY: Keeps API-platform billing out of the view. */
export const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
/** WHAT: Names Kimi quota provenance. WHY: Keeps a provider read distinct from snapshot delivery time. */
export const KIMI_QUOTA_SOURCE = "kimi.code.usage";

const profileView = (profile) => ({
  id: profile.id,
  key: profile.key,
  label: profile.label,
  source: profile.source,
});

const failure = (profile, error) => ({
  ok: false,
  engine: "kimi",
  provider: "kimi",
  profile: profileView(profile),
  error,
});

const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : null;

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const firstText = (source, keys) => {
  for (const key of keys) {
    if (typeof source?.[key] === "string" && source[key].trim()) return source[key].trim();
  }
  return null;
};

const resetAt = (source, observedMs) => {
  const absolute = firstText(source, ["reset_at", "resetAt", "reset_time", "resetTime"]);
  if (absolute && Number.isFinite(Date.parse(absolute))) return new Date(absolute).toISOString();
  const seconds = finite(source?.reset_in ?? source?.resetIn ?? source?.ttl);
  return seconds !== null && seconds > 0
    ? new Date(observedMs + seconds * 1000).toISOString()
    : null;
};

const durationLabel = (item, detail) => {
  const window = object(item?.window) ?? {};
  const duration = finite(window.duration ?? item?.duration ?? detail?.duration);
  const unit = String(window.timeUnit ?? item?.timeUnit ?? detail?.timeUnit ?? "").toUpperCase();
  if (duration === null || duration <= 0) return null;
  if (unit.includes("MINUTE") && duration % 60 === 0) return `${duration / 60} h`;
  if (unit.includes("MINUTE")) return `${duration} min`;
  if (unit.includes("HOUR")) return `${duration} h`;
  if (unit.includes("DAY")) return `${duration} d`;
  return null;
};

const usageRow = (source, { id, label, kind, observedMs }) => {
  const limit = finite(source?.limit);
  let used = finite(source?.used);
  if (used === null && limit !== null) {
    const remaining = finite(source?.remaining);
    if (remaining !== null) used = limit - remaining;
  }
  if (limit === null || limit <= 0 || used === null) return null;
  const usedPercent = clampQuotaPercent((used / limit) * 100);
  if (usedPercent === null) return null;
  return {
    id,
    kind,
    scopeName: label,
    usedPercent,
    resetsAt: resetAt(source, observedMs),
    isActive: true,
  };
};

const identityKey = (token) => {
  const payload = String(token || "").split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (typeof claims.sub !== "string" || !claims.sub) return null;
    return createHash("sha256")
      .update(`${claims.iss || "kimi"}:${claims.sub}`)
      .digest("base64url");
  } catch {
    return null;
  }
};

const planFrom = (payload) => {
  for (const candidate of [payload?.plan, payload?.tier, payload?.membership]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    const named = firstText(object(candidate), ["display_name", "displayName", "name", "title"]);
    if (named) return named;
  }
  return null;
};

/** WHAT: Normalizes Kimi's documented usage payload. WHY: Keeps provider JSON out of shared consumers. */
export function normalizeKimiQuota(profile, payload, credentials, observedAt) {
  const observedMs = Date.parse(observedAt);
  const rows = [];
  const summary = usageRow(object(payload?.usage), {
    id: "weekly",
    label: "Vecka",
    kind: "weekly",
    observedMs,
  });
  if (summary) rows.push(summary);
  const limits = Array.isArray(payload?.limits) ? payload.limits : [];
  limits.forEach((raw, index) => {
    const item = object(raw);
    if (!item) return;
    const detail = object(item.detail) ?? item;
    const label = firstText(item, ["name", "title", "scope"])
      ?? firstText(detail, ["name", "title", "scope"])
      ?? durationLabel(item, detail)
      ?? `Gräns ${index + 1}`;
    const row = usageRow(detail, {
      id: `limit-${index + 1}`,
      label,
      kind: "window",
      observedMs,
    });
    if (row && !rows.some((existing) => existing.scopeName === row.scopeName
      && existing.usedPercent === row.usedPercent && existing.resetsAt === row.resetsAt)) {
      rows.push(row);
    }
  });
  if (!rows.length) return failure(profile, "no_limits_in_response");
  const headline = rows.reduce((tightest, row) =>
    row.usedPercent > tightest.usedPercent ? row : tightest, rows[0]);
  return {
    ok: true,
    engine: "kimi",
    provider: "kimi",
    profile: profileView(profile),
    account: {
      email: null,
      identityKey: identityKey(credentials?.access_token),
      plan: planFrom(payload),
    },
    observation: quotaObservation({
      source: KIMI_QUOTA_SOURCE,
      observedAt,
      usedPercent: headline.usedPercent,
      resetsAt: headline.resetsAt,
    }),
    limits: rows,
  };
}

/** WHAT: Reads one Kimi coding profile. WHY: Keeps profile OAuth isolated and token-free in output. */
export async function readKimiAccountQuota(profile, {
  fetchImpl = fetch,
  timeoutMs = 10_000,
  now = Date.now,
} = {}) {
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(profile.credentialsPath, "utf8"));
  } catch {
    return failure(profile, "login_required");
  }
  if (typeof credentials?.access_token !== "string" || !credentials.access_token) {
    return failure(profile, "login_required");
  }
  const nowMs = now();
  const expiresAt = finite(credentials.expires_at);
  if (expiresAt !== null && expiresAt * 1000 <= nowMs) {
    return failure(profile, "credentials_expired");
  }
  let response;
  try {
    response = await fetchImpl(KIMI_USAGE_URL, {
      headers: { authorization: `Bearer ${credentials.access_token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return failure(profile, "network_error");
  }
  if (!response.ok) {
    return failure(profile, response.status === 401 || response.status === 403
      ? "credentials_expired" : `http_${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return failure(profile, "invalid_response");
  }
  return normalizeKimiQuota(profile, payload, credentials, new Date(nowMs).toISOString());
}
