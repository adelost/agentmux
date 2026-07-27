// Gemini CLI subscription quota for one provider-owned OAuth profile.
//
// The quota endpoints and installed-client credential discovery mirror the
// MIT-licensed CodexBar Gemini adapter, reduced to the account fields agentmux
// needs. API-key billing is intentionally out of scope.

import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { clampQuotaPercent, quotaObservation } from "./quota-observation.mjs";

/** WHAT: Names Google's OAuth refresh endpoint. WHY: Keeps refresh in the CLI's own profile. */
export const GEMINI_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** WHAT: Names Code Assist tier discovery. WHY: Keeps API-key billing out of the dashboard. */
export const GEMINI_LOAD_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
/** WHAT: Names Code Assist quota discovery. WHY: Keeps model allowance tied to the coding subscription. */
export const GEMINI_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
/** WHAT: Defines Gemini observation provenance. WHY: Keeps provenance visible across clients. */
export const GEMINI_QUOTA_SOURCE = "gemini.code_assist.quota";

const failure = (profile, error) => ({
  ok: false,
  engine: "gemini",
  provider: "gemini",
  profile: { id: profile.id, key: profile.key, label: profile.label, source: profile.source },
  error,
});

const decodeClaims = (token) => {
  const payload = String(token || "").split(".")[1];
  if (!payload) return {};
  try { return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); }
  catch { return {}; }
};

const planFrom = (payload, claims) => {
  const paid = payload?.paidTier?.name;
  if (typeof paid === "string" && paid.trim()) return paid.trim();
  const tier = payload?.currentTier?.id;
  if (tier === "standard-tier") return "Paid";
  if (tier === "free-tier" && claims.hd) return "Workspace";
  if (tier === "free-tier") return "Free";
  if (tier === "legacy-tier") return "Legacy";
  return null;
};

const deprecationError = (payload) => {
  const text = JSON.stringify(payload || {});
  return /UNSUPPORTED_CLIENT|IneligibleTierError|migrat\w+\s+to\s+(?:the\s+)?Antigravity/iu.test(text)
    ? "consumer_tier_moved_to_antigravity" : null;
};

/** WHAT: Normalizes Gemini buckets. WHY: Keeps raw OAuth and tier payloads out of shared consumers. */
export function normalizeGeminiQuota(profile, quotaPayload, codeAssistPayload, credentials, observedAt) {
  const claims = decodeClaims(credentials?.id_token);
  const observedMs = Date.parse(observedAt);
  const limits = (Array.isArray(quotaPayload?.buckets) ? quotaPayload.buckets : [])
    .flatMap((bucket, index) => {
      const remaining = clampQuotaPercent(Number(bucket?.remainingFraction) * 100);
      if (remaining === null) return [];
      const model = typeof bucket?.modelId === "string" && bucket.modelId
        ? bucket.modelId : `model-${index + 1}`;
      const resetMs = Date.parse(String(bucket?.resetTime || ""));
      return [{
        id: model,
        kind: "model",
        scopeName: model,
        usedPercent: Math.round((100 - remaining) * 10) / 10,
        resetsAt: Number.isFinite(resetMs) && resetMs >= observedMs ? bucket.resetTime : null,
        isActive: true,
      }];
    });
  if (!limits.length) return failure(profile, "no_limits_in_response");
  const headline = limits.reduce((highest, row) =>
    row.usedPercent > highest.usedPercent ? row : highest, limits[0]);
  return {
    ok: true,
    engine: "gemini",
    provider: "gemini",
    profile: { id: profile.id, key: profile.key, label: profile.label, source: profile.source },
    account: {
      email: typeof claims.email === "string" ? claims.email : null,
      organization: typeof claims.hd === "string" ? claims.hd : null,
      plan: planFrom(codeAssistPayload, claims),
    },
    observation: quotaObservation({
      source: GEMINI_QUOTA_SOURCE,
      observedAt,
      usedPercent: headline.usedPercent,
      resetsAt: headline.resetsAt,
    }),
    limits,
  };
}

const findOnPath = (name, env = process.env) => String(env.PATH || "").split(delimiter)
  .map((dir) => join(dir, name))
  .find((path) => existsSync(path)) ?? null;

const oauthFromText = (text) => {
  const id = text.match(/(?:const|let|var)?\s*OAUTH_CLIENT_ID\s*=\s*["']([\w.-]+)["']\s*;/u)?.[1];
  const secret = text.match(/(?:const|let|var)?\s*OAUTH_CLIENT_SECRET\s*=\s*["']([\w-]+)["']\s*;/u)?.[1];
  return id && secret ? { clientId: id, clientSecret: secret } : null;
};

const importsFrom = (text) => [...text.matchAll(
  /(?:from\s*|import\(\s*)["'](\.\/[^"']+\.js)["']/gu,
)].map((match) => match[1]);

/** WHAT: Reads the installed Gemini public client. WHY: Keeps bundled credentials out of source. */
export function discoverGeminiOAuthClient({
  env = process.env,
  executable = findOnPath("gemini", env),
  maxBytes = 40 * 1024 * 1024,
} = {}) {
  if (env.AMUX_GEMINI_OAUTH_CLIENT_ID && env.AMUX_GEMINI_OAUTH_CLIENT_SECRET) {
    return { clientId: env.AMUX_GEMINI_OAUTH_CLIENT_ID,
      clientSecret: env.AMUX_GEMINI_OAUTH_CLIENT_SECRET };
  }
  if (!executable) return null;
  let entry;
  try { entry = realpathSync(executable); }
  catch { return null; }
  const bundle = dirname(entry);
  const queue = [entry];
  const seen = new Set();
  let bytes = 0;
  const bundleRoot = `${resolve(bundle)}/`;
  const entryPath = resolve(entry);
  while (queue.length && bytes < maxBytes) {
    const path = queue.shift();
    const resolvedPath = resolve(path);
    if (seen.has(resolvedPath)
      || (!resolvedPath.startsWith(bundleRoot) && resolvedPath !== entryPath)) {
      continue;
    }
    seen.add(resolvedPath);
    let text;
    try { text = readFileSync(path, "utf8"); }
    catch { continue; }
    bytes += Buffer.byteLength(text);
    const found = oauthFromText(text);
    if (found) return found;
    for (const imported of importsFrom(text)) queue.push(resolve(dirname(path), imported));
  }
  // Bundlers can leave the credential chunk outside the entry import graph.
  let files;
  try { files = readdirSync(bundle).filter((name) => name.endsWith(".js")).sort(); }
  catch { return null; }
  for (const name of files) {
    const path = join(bundle, name);
    if (seen.has(path)) continue;
    let text;
    try { text = readFileSync(path, "utf8"); }
    catch { continue; }
    const found = oauthFromText(text);
    if (found) return found;
  }
  return null;
}

const writeCredentialsAtomic = (path, document) => {
  const temp = `${path}.agentmux-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
};

const postJson = async (url, payload, token, { fetchImpl, timeoutMs }) => {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body = null;
    try { body = await response.json(); } catch {}
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: 0, body: null, network: true };
  }
};

/** WHAT: Saves one refreshed Gemini token. WHY: Keeps expired login state actionable. */
export async function refreshGeminiCredentials(document, {
  credentialsPath,
  oauthClient = discoverGeminiOAuthClient(),
  fetchImpl = fetch,
  timeoutMs = 10_000,
  now = Date.now,
  persist = writeCredentialsAtomic,
} = {}) {
  if (!document?.refresh_token) return { ok: false, error: "login_required" };
  if (!oauthClient) return { ok: false, error: "oauth_client_unavailable" };
  let response;
  try {
    response = await fetchImpl(GEMINI_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthClient.clientId,
        client_secret: oauthClient.clientSecret,
        refresh_token: document.refresh_token,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, error: "network_error" };
  }
  let payload = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    return { ok: false, error: deprecationError(payload)
      || (response.status === 400 || response.status === 401 ? "login_required" : `refresh_http_${response.status}`) };
  }
  if (typeof payload?.access_token !== "string") {
    return { ok: false, error: "refresh_invalid_response" };
  }
  const expiresIn = Number(payload.expires_in);
  const refreshed = {
    ...document,
    access_token: payload.access_token,
    id_token: payload.id_token || document.id_token,
    expiry_date: Number.isFinite(expiresIn) ? now() + expiresIn * 1000 : document.expiry_date,
  };
  if (credentialsPath && persist) persist(credentialsPath, refreshed);
  return { ok: true, document: refreshed };
}

/** WHAT: Reads one Gemini coding profile. WHY: Keeps subscription quota separate from API usage. */
export async function readGeminiAccountQuota(profile, {
  fetchImpl = fetch,
  timeoutMs = 10_000,
  now = Date.now,
  oauthClient,
  persist,
} = {}) {
  let credentials;
  try { credentials = JSON.parse(readFileSync(profile.credentialsPath, "utf8")); }
  catch { return failure(profile, "credentials_unavailable"); }
  if (!credentials.access_token) return failure(profile, "login_required");
  if (!Number.isFinite(Number(credentials.expiry_date)) || Number(credentials.expiry_date) <= now()) {
    const refreshed = await refreshGeminiCredentials(credentials, {
      credentialsPath: profile.credentialsPath,
      fetchImpl, timeoutMs, now,
      ...(oauthClient ? { oauthClient } : {}),
      ...(persist ? { persist } : {}),
    });
    if (!refreshed.ok) return failure(profile, refreshed.error);
    credentials = refreshed.document;
  }

  const request = { fetchImpl, timeoutMs };
  const codeAssist = await postJson(GEMINI_LOAD_URL, {
    metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" },
  }, credentials.access_token, request);
  if (!codeAssist.ok) {
    return failure(profile, deprecationError(codeAssist.body)
      || (codeAssist.network ? "network_error" : codeAssist.status === 401 ? "login_required"
        : `load_http_${codeAssist.status}`));
  }
  const project = typeof codeAssist.body?.cloudaicompanionProject === "string"
    ? codeAssist.body.cloudaicompanionProject
    : codeAssist.body?.cloudaicompanionProject?.id
      || codeAssist.body?.cloudaicompanionProject?.projectId
      || null;
  const quota = await postJson(GEMINI_QUOTA_URL, project ? { project } : {},
    credentials.access_token, request);
  if (!quota.ok) {
    return failure(profile, deprecationError(quota.body)
      || (quota.network ? "network_error" : quota.status === 401 ? "login_required"
        : `quota_http_${quota.status}`));
  }
  return normalizeGeminiQuota(profile, quota.body, codeAssist.body, credentials,
    new Date(now()).toISOString());
}
