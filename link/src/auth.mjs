// Link auth: the v1d identity leg, the app exchange leg, and revocable
// Link sessions (docs/link-internet-v1.md). Worker-compatible WebCrypto only.

import { base64Url, pkceChallenge, randomId, safeEqual, sha256Hex } from "./util.mjs";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function stateKey(secret) {
  const raw = new Uint8Array(secret.match(/.{2}/g).map((hex) => parseInt(hex, 16)));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** WHAT: Encodes one login transaction with AES-GCM. WHY: Prevents a forged or replayed callback from becoming a session. */
export async function sealState(secret, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await stateKey(secret);
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    textEncoder.encode(JSON.stringify(payload)),
  ));
  const envelope = new Uint8Array(iv.length + sealed.length);
  envelope.set(iv);
  envelope.set(sealed, iv.length);
  return `v1_${base64Url(envelope)}`;
}

/** WHAT: Decodes a sealed login transaction. WHY: Keeps callback state confidential and tamper-evident. */
export async function openState(secret, state) {
  try {
    const encoded = String(state || "");
    if (!/^v1_[A-Za-z0-9_-]+$/u.test(encoded)) return null;
    const base64 = encoded.slice(3).replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const envelope = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    if (envelope.length <= 28) return null;
    const iv = envelope.slice(0, 12);
    const sealed = envelope.slice(12);
    const key = await stateKey(secret);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, sealed);
    return JSON.parse(textDecoder.decode(plain));
  } catch {
    return null;
  }
}

/** WHAT: Checks one broker principal shape and extracts its identity. WHY: Prevents a malformed identity response from becoming a session. */
export function validLinkPrincipal(value) {  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value;
  if (typeof row.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(row.id)) return null;
  const email = typeof row.verifiedEmail === "string"
    && /^[^\s@]{1,80}@[^\s@]{1,80}$/u.test(row.verifiedEmail)
    ? row.verifiedEmail
    : null;
  return { identityId: row.id, name: typeof row.name === "string" ? row.name.slice(0, 80) : "", email };
}

/** WHAT: Builds the v1d authorize URL for one app login. WHY: Keeps the broker contract identical to the proven client shape. */
export async function beginLinkLogin({ env, challenge, client = "android" }) {
  const verifier = randomId(24);
  const state = await sealState(env.V1D_AUTH_STATE_SECRET, {
    verifier,
    challenge,
    client,
    expiresAt: Date.now() + 10 * 60_000,
  });
  const target = new URL("/authorize", env.V1D_AUTH_ORIGIN);
  target.searchParams.set("app_id", env.V1D_AUTH_APP_ID);
  target.searchParams.set("redirect_uri", env.V1D_AUTH_CALLBACK_URL);
  target.searchParams.set("state", state);
  target.searchParams.set("code_challenge", await pkceChallenge(verifier));
  target.searchParams.set("code_challenge_method", "S256");
  return target.toString();
}

async function brokerPost(env, path, body) {
  const response = await fetch(`${env.V1D_AUTH_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.V1D_AUTH_APP_ID}:${env.V1D_AUTH_CLIENT_SECRET}`)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) return { ok: false, reason: `broker-${response.status}` };
  return { ok: true, result };
}

/** WHAT: Resolves the v1d callback into a verified identity. WHY: Keeps token exchange bound to the sealed transaction. */
export async function completeLinkLogin({ env, url }) {
  const code = url.searchParams.get("code");
  const state = await openState(env.V1D_AUTH_STATE_SECRET, url.searchParams.get("state"));
  if (!code || !state || typeof state.verifier !== "string" || Date.now() > Number(state.expiresAt || 0)) {
    return { ok: false, reason: "invalid-identity-transaction" };
  }
  const exchanged = await brokerPost(env, "/token", {
    grantType: "authorization_code",
    code,
    codeVerifier: state.verifier,
    redirectUri: env.V1D_AUTH_CALLBACK_URL,
  });
  if (!exchanged.ok) return exchanged;
  const principal = validLinkPrincipal(exchanged.result?.principal);
  if (!principal) return { ok: false, reason: "invalid-identity-response" };
  return { ok: true, principal, challenge: state.challenge, client: state.client };
}

/** WHAT: Builds a revocable Link session for one verified identity. WHY: Keeps raw identity out of the app after first bind. */
export async function issueSession({ store, identityId, nowMs, ttlSeconds }) {
  const token = `lnk_${randomId(24)}`;
  await store.insertSession({
    tokenHash: await sha256Hex(token),
    identityId,
    nowMs,
    ttlSeconds,
  });
  return token;
}

/** WHAT: Resolves a bearer token to a live session. WHY: Keeps revoked and expired sessions dead. */
export async function requireSession({ store, request, nowMs }) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(lnk_\S+)$/u.exec(header.trim());
  if (!match) return null;
  return store.sessionFor(await sha256Hex(match[1]), nowMs);
}

/** WHAT: Resolves a connector credential to its identity. WHY: Keeps connector scope pinned to its own targets. */
export function requireConnector({ env, request, source }) {
  const header = request.headers.get("authorization") || "";
  const match = /^Bearer\s+(\S+)$/u.exec(header.trim());
  const expected = source === "wsl" ? env.CONNECTOR_TOKEN_WSL : env.CONNECTOR_TOKEN_WINDOWS;
  if (!match || !expected || !safeEqual(match[1], expected)) return null;
  const targets = source === "wsl"
    ? String(env.CONNECTOR_TARGETS_WSL || "lsrc:3,lsrc:10").split(",").map((t) => t.trim()).filter(Boolean)
    : ["windows"];
  return { connectorId: `${source}-1`, source, targets };
}
