// Shared configuration and rate-limit helpers for the Link worker routes.

import { sha256Hex } from "./util.mjs";

/** WHAT: Defines the clientMessageId UUID shape. WHY: Keeps malformed ids out of the mailbox keyspace. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** WHAT: Defines the hex shape of worker secrets. WHY: Keeps weak or malformed secrets from starting the service. */
export const HEX_SECRET_RE = /^[0-9a-f]{64,256}$/iu;
const CONTROL_CHARS_RE = /[\u0000-\u0020\u007f]/u;

function httpsUrl(value, { callback = false } = {}) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    if (callback && url.pathname !== "/auth/callback") return null;
    if (!callback && url.pathname !== "/") return null;
    return url.toString().replace(/\/$/u, "");
  } catch { return null; }
}

/** WHAT: Resolves Link's identity-provider bindings. WHY: Keeps self-hosted Link separate from one operator's domain. */
export function linkAuthConfig(env) {
  return {
    origin: httpsUrl(env.LINK_AUTH_ORIGIN ?? env.V1D_AUTH_ORIGIN),
    callbackUrl: httpsUrl(env.LINK_AUTH_CALLBACK_URL ?? env.V1D_AUTH_CALLBACK_URL, {
      callback: true,
    }),
    appId: String(env.LINK_AUTH_APP_ID ?? env.V1D_AUTH_APP_ID ?? ""),
    clientSecret: String(env.LINK_AUTH_CLIENT_SECRET ?? env.V1D_AUTH_CLIENT_SECRET ?? ""),
    stateSecret: String(env.LINK_AUTH_STATE_SECRET ?? env.V1D_AUTH_STATE_SECRET ?? ""),
  };
}

/** WHAT: Checks that every binding and secret the worker needs is present. WHY: Keeps a misconfigured deploy from serving as if healthy. */
export function configured(env) {
  const auth = linkAuthConfig(env);
  return Boolean(
    env.LINK_DB?.prepare
    && env.LINK_VOICE?.get
    && env.LINK_RELEASES?.get
    && auth.origin
    && auth.callbackUrl
    && /^[a-z0-9][a-z0-9_-]{2,63}$/u.test(auth.appId)
    && auth.clientSecret.length >= 32
    && HEX_SECRET_RE.test(auth.stateSecret)
    && String(env.CONNECTOR_TOKEN_WSL || "").length >= 32
    && String(env.CONNECTOR_TOKEN_WINDOWS || "").length >= 32
    && connectorTargets(env, "wsl").length > 0
    && connectorTargets(env, "windows").length > 0
    && targetsForApp(env).length > 0
  );
}

/** WHAT: Resolves the app-visible target list with labels and kinds. WHY: Keeps favorite presentation out of each route. */
export function targetsForApp(env) {
  return String(env.LINK_TARGETS || "")
    .split(",").map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => {
      const [id, label] = entry.split("|");
      return { id, label: label || id, kind: id === "windows" ? "windows" : "agent" };
    });
}

/** WHAT: Defines the shape of a fleet pane address. WHY: Only `agent:pane` may
 *  be announced, so a connector can never claim a privileged kind like windows. */
export const AGENT_TARGET_RE = /^[a-z][a-z0-9_-]{0,31}:\d{1,3}$/u;
const MAX_ANNOUNCED_TARGETS = 200;
const MAX_LABEL_CHARS = 64;
const MAX_MODEL_CHARS = 120;
const MAX_EFFORT_CHARS = 24;

function boundedModelValue(value, max) {
  const clean = String(value || "").replace(/[\u0000-\u001f\u007f]/gu, "").trim();
  return clean ? clean.slice(0, max) : null;
}

/** WHAT: Returns one bounded connector model projection. WHY: Keeps pane evidence typed and non-secret before D1 persistence. */
export function announceableTargetModel(raw) {
  const status = ["current", "stale", "unknown"].includes(raw?.status)
    ? raw.status : "unknown";
  const observedModel = boundedModelValue(raw?.observed?.model, MAX_MODEL_CHARS);
  const configuredModel = boundedModelValue(raw?.configured?.model, MAX_MODEL_CHARS);
  return {
    status: observedModel ? status : "unknown",
    observed: observedModel ? {
      model: observedModel,
      effort: boundedModelValue(raw?.observed?.effort, MAX_EFFORT_CHARS),
    } : null,
    configured: configuredModel ? {
      model: configuredModel,
      effort: boundedModelValue(raw?.configured?.effort, MAX_EFFORT_CHARS),
    } : null,
  };
}

/** WHAT: How long an announced target stays listed after its last poll. WHY: A
 *  bridge restart must not empty the phone's list, a removed pane must not linger. */
export function targetAnnounceTtlMs(env) {
  return (Number(env.TARGET_ANNOUNCE_TTL_SECONDS) || 24 * 3600) * 1000;
}

/**
 * WHAT: How many times one message may be handed to a connector before the
 * mailbox calls it unanswered.
 * WHY: A turn that is claimed for ever is a lie on the phone: it shows pending
 * while nothing will ever come. Row 187, measured: Mattias's "hej" to lsrc:3
 * reached 377 attempts over nine hours, one D1 write per claim, with no state
 * the app could show him. Each attempt costs a full reply window
 * (REPLY_TIMEOUT_SECONDS, ten minutes by default), so five is about an hour of
 * genuine patience before the mailbox stops pretending.
 */
export function maxDeliveryAttempts(env) {
  const declared = Number(env.MAX_DELIVERY_ATTEMPTS);
  return Number.isInteger(declared) && declared > 0 ? declared : 5;
}

/** WHAT: Filters announced entries before storage. WHY: Keeps untrusted connector input within worker bounds. */
export function announceableTargets(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const targets = [];
  for (const row of rows) {
    const id = String(row?.id || "").trim();
    if (!AGENT_TARGET_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    // Its own global regex: the shared CONTROL_CHARS_RE is a .test() guard, and
    // a replace needs every control char gone, not just the first.
    const label = String(row?.label || "").replace(/[\u0000-\u0020\u007f]/gu, " ")
      .trim().slice(0, MAX_LABEL_CHARS);
    targets.push({
      id,
      label: label || id,
      kind: "agent",
      model: announceableTargetModel(row?.model),
    });
    if (targets.length >= MAX_ANNOUNCED_TARGETS) break;
  }
  return targets;
}

/** WHAT: Builds one target list from configured and announced rows. WHY: Separates configured identity from live model evidence. */
export function mergeTargets(seed, announced) {
  const merged = seed.map((target) => ({ ...target }));
  const byId = new Map(merged.map((target) => [target.id, target]));
  for (const row of announced) {
    const existing = byId.get(row.id);
    if (existing) {
      // The configured row still owns wording/kind. Live pane evidence belongs
      // to the connector and must not disappear merely because the id is seeded.
      existing.model = row.model || existing.model;
      existing.connectorId = row.connectorId || existing.connectorId;
      continue;
    }
    const target = {
      id: row.id,
      label: row.label || row.id,
      kind: row.kind || "agent",
      // Who announced it: the route reads the owner's beat for online.
      connectorId: row.connectorId,
    };
    byId.set(target.id, target);
    merged.push(target);
  }
  return merged;
}

/** WHAT: Resolves private Tailscale or LAN discovery URLs for the app. WHY: Keeps fallback transport hints server-driven and bounded. */
export function privateDiscoveryUrlsForApp(env) {
  return String(env.LINK_PRIVATE_DISCOVERY_URLS || "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/u, ""))
    .filter((entry, index, rows) => entry && rows.indexOf(entry) === index)
    .slice(0, 8);
}

/** WHAT: Resolves connector-owned targets. WHY: Keeps private fleet identities in deployment config instead of source. */
export function connectorTargets(env, source) {
  const raw = source === "wsl" ? env.CONNECTOR_TARGETS_WSL : env.CONNECTOR_TARGETS_WINDOWS;
  return String(raw || "").split(",").map((target) => target.trim()).filter(Boolean);
}

/** WHAT: Checks one request against its subject and client-IP windows. WHY: Prevents a single session or address from hammering one route. */
export async function requestRateLimited({ store, request, subject, scope, bucket, max }) {
  const subjects = [subject];
  const ip = request.headers.get("cf-connecting-ip");
  if (ip && ip.length <= 64 && !CONTROL_CHARS_RE.test(ip)) {
    subjects.push(`ip:${await sha256Hex(ip)}`);
  }
  for (const current of subjects) {
    if (await store.hitRateLimit({ subject: current, scope, bucket, max })) return true;
  }
  return false;
}
