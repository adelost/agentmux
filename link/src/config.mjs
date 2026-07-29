// Shared configuration and rate-limit helpers for the Link worker routes.

import { sha256Hex } from "./util.mjs";

/** WHAT: Defines the clientMessageId UUID shape. WHY: Keeps malformed ids out of the mailbox keyspace. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
/** WHAT: Defines the hex shape of worker secrets. WHY: Keeps weak or malformed secrets from starting the service. */
export const HEX_SECRET_RE = /^[0-9a-f]{64,256}$/iu;
const CONTROL_CHARS_RE = /[\u0000-\u0020\u007f]/u;

/** WHAT: Checks that every binding and secret the worker needs is present. WHY: Keeps a misconfigured deploy from serving as if healthy. */
export function configured(env) {
  return Boolean(
    env.LINK_DB?.prepare
    && env.LINK_VOICE?.get
    && env.LINK_RELEASES?.get
    && env.V1D_AUTH_ORIGIN === "https://auth.v1d.io"
    && env.V1D_AUTH_CALLBACK_URL === "https://link.v1d.io/auth/callback"
    && env.V1D_AUTH_APP_ID === "agentmux-link"
    && String(env.V1D_AUTH_CLIENT_SECRET || "").length >= 32
    && HEX_SECRET_RE.test(String(env.V1D_AUTH_STATE_SECRET || ""))
    && String(env.CONNECTOR_TOKEN_WSL || "").length >= 32
    && String(env.CONNECTOR_TOKEN_WINDOWS || "").length >= 32
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

/** WHAT: Resolves private Tailscale or LAN discovery URLs for the app. WHY: Keeps fallback transport hints server-driven and bounded. */
export function privateDiscoveryUrlsForApp(env) {
  return String(env.LINK_PRIVATE_DISCOVERY_URLS || "")
    .split(",")
    .map((entry) => entry.trim().replace(/\/+$/u, ""))
    .filter((entry, index, rows) => entry && rows.indexOf(entry) === index)
    .slice(0, 8);
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
