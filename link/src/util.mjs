// Shared crypto/http helpers for the Link worker. Worker-compatible (WebCrypto).

/** WHAT: Formats one JSON response with no-store headers. WHY: Keeps mailbox answers from being cached anywhere. */
export const json = (res, status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

/** WHAT: Normalizes and bounds one text field. WHY: Prevents oversized payloads from reaching the store. */
export const text = (value, limit) => {
  const clean = String(value ?? "").trim();
  return clean.length > limit ? clean.slice(0, limit) : clean;
};

/** WHAT: Builds one random hex id. WHY: Keeps tokens and message ids unguessable. */
export function randomId(bytes = 16) {
  const raw = new Uint8Array(bytes);
  crypto.getRandomValues(raw);
  return [...raw].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** WHAT: Builds the lowercase hex SHA-256 of one value. WHY: Keeps raw session tokens out of the database. */
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** WHAT: Formats bytes as URL-safe base64. WHY: Keeps challenges and sealed states transport-safe. */
export function base64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** WHAT: Builds one S256 PKCE challenge from a verifier. WHY: Prevents an intercepted code from being exchanged. */
export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

/** WHAT: Compares two tokens in constant time. WHY: Prevents timing leaks from giving token bytes away. */
export function safeEqual(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
