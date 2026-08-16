import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import { describeManglingRisk, findManglingRiskInPayload } from "./mangled-swedish.mjs";
import { normalizeServiceBaseUrl } from "./runtime-defaults.mjs";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const MUTATING_SHELL = /(?:\b(?:curl|wget)\b[\s\S]*(?:\s-X\s*|--request(?:=|\s+)|\s-(?:d|F)\s|--data(?:-binary|raw|urlencode)?(?:=|\s+)|--form(?:=|\s+))|\b(?:fetch|Request)\s*\([\s\S]*?\bmethod\s*[:=]\s*["']?(?:POST|PATCH|PUT|DELETE))/iu;
const CANONICAL_CLIENT = /(?:^|[;&|]\s*)(?:env\s+)?(?:node\s+\S*\/)?amux-suggest(?:\.mjs)?(?:\s|$)/mu;

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * WHAT: Checks direct Suggestions mutations for bypasses of the canonical file writer.
 * WHY: Keeps agent-authored human text behind exact UTF-8 verification before transport.
 */
export function inspectSuggestionsMutationCommand(command, {
  baseUrl = process.env.SUGGEST_BASE_URL,
} = {}) {
  const text = String(command ?? "");
  if (!baseUrl) return { blocked: false, reason: null };
  const origin = normalizeServiceBaseUrl(baseUrl, "Suggestions base URL", {
    allowHttpLoopback: process.env.NODE_ENV === "test",
  });
  if (!text.includes(`${origin}/api/`) || !MUTATING_SHELL.test(text)) {
    return { blocked: false, reason: null };
  }
  if (CANONICAL_CLIENT.test(text)
    && !/\b(?:curl|wget|fetch|urllib\.request|https?\.request)\b/u.test(text)) {
    return { blocked: false, reason: null };
  }
  return {
    blocked: true,
    reason: "Direct Suggestions mutations bypass the UTF-8/verbatim source gate. "
      + "Write the JSON body to a UTF-8 file and use amux-suggest; for human quotes, "
      + "also pass --expect-file and --read-path so the exact text is checked before HTTP and after GET.",
  };
}

/**
 * WHAT: Decodes one byte sequence as BOM-free strict UTF-8.
 * WHY: Prevents invalid or ambiguous text bytes from entering verified API payloads.
 */
export function strictUtf8(bytes, label = "input") {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) throw new Error("UTF-8 BOM is not accepted");
    return text;
  } catch (error) {
    throw new Error(`${label} is not strict UTF-8: ${error.message}`);
  }
}

function allStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => allStrings(item, output));
  }
  return output;
}

function parseJsonBytes(bytes, label) {
  const text = strictUtf8(bytes, label);
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

/**
 * WHAT: Checks trusted source files occur unchanged as literal UTF-8 in request JSON.
 * WHY: Keeps agent-side transliteration from reaching Suggestions.
 */
export function assertVerbatimSources(bodyBytes, sourceBytes) {
  const { value } = parseJsonBytes(bodyBytes, "request body");
  const values = allStrings(value);
  return sourceBytes.map((bytes, index) => {
    const fileText = strictUtf8(bytes, `verbatim source ${index + 1}`);
    const source = fileText.endsWith("\r\n")
      ? fileText.slice(0, -2)
      : fileText.endsWith("\n") ? fileText.slice(0, -1) : fileText;
    if (!source) throw new Error(`verbatim source ${index + 1} is empty`);
    if (!values.some((valueText) => valueText.includes(source))) {
      throw new Error(`verbatim source ${index + 1} is not present unchanged in the request body`);
    }
    if (bodyBytes.indexOf(Buffer.from(source, "utf8")) < 0) {
      throw new Error(`verbatim source ${index + 1} is not encoded as literal UTF-8 in the request body`);
    }
    return source;
  });
}

function mutationIdFrom(value) {
  const mutationId = value?.mutationId;
  if (typeof mutationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(mutationId)) {
    throw new Error("request body must contain a UUID mutationId");
  }
  return mutationId.toLowerCase();
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

const FAILURE_DETAIL_BYTES = 20_000;

/**
 * WHAT: Keeps a rejection body whole, and says so out loud when it cannot.
 * WHY: Some rejections are handshakes, not just complaints. A 428
 * `policy-ack-required` answers with the exact acknowledgement the caller must
 * echo back, and that payload is longer than the 500 characters this used to
 * keep — so the sanctioned client could never complete the exchange it was told
 * to complete. Worse, the cut landed mid-value and produced text that still
 * looked like JSON, so a reader could not tell a whole body from a severed one.
 * Measured 2026-08-04 on `release-off-board` for SRC-0086.
 *
 * The bound stays, because a proxy can answer with a megabyte of HTML, but it is
 * now far above any protocol payload and truncation is explicit rather than
 * silent.
 */
export function failureDetail(text) {
  return text.length <= FAILURE_DETAIL_BYTES ? text
    : `${text.slice(0, FAILURE_DETAIL_BYTES)}\n[amux-suggest: response truncated at `
      + `${FAILURE_DETAIL_BYTES} of ${text.length} characters]`;
}

/**
 * WHAT: Stores one mutation identity and exact body before network delivery.
 * WHY: Prevents idempotency reuse from silently carrying different text.
 */
export function stageSuggestionsRequest({ bodyBytes, method, url, stateDir }) {
  const { value } = parseJsonBytes(bodyBytes, "request body");
  const mutationId = mutationIdFrom(value);
  const requestHash = sha256(bodyBytes);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const metadataPath = join(stateDir, `${mutationId}.json`);
  const bodyPath = join(stateDir, `${mutationId}.body.json`);
  if (existsSync(metadataPath) || existsSync(bodyPath)) {
    if (!existsSync(metadataPath) || !existsSync(bodyPath)) {
      throw new Error(`incomplete persisted request for ${mutationId}`);
    }
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    const persisted = readFileSync(bodyPath);
    if (metadata.method !== method || metadata.url !== url
      || metadata.requestHash !== requestHash || sha256(persisted) !== requestHash) {
      throw new Error(`mutationId ${mutationId} is already persisted with a different request`);
    }
    return { mutationId, metadataPath, bodyPath, bodyBytes: persisted, replay: true };
  }
  writeFileSync(bodyPath, bodyBytes, { flag: "wx", mode: 0o600 });
  atomicJson(metadataPath, {
    schemaVersion: 1, mutationId, method, url, requestHash,
    state: "staged", stagedAt: new Date().toISOString(),
  });
  return { mutationId, metadataPath, bodyPath, bodyBytes, replay: false };
}

function assertReadback(responseBytes, expected) {
  const { value } = parseJsonBytes(responseBytes, "readback response");
  const values = allStrings(value);
  expected.forEach((source, index) => {
    if (!values.some((valueText) => valueText.includes(source))) {
      throw new Error(`verbatim source ${index + 1} was not returned unchanged by readback`);
    }
  });
}

/**
 * WHAT: Dispatches one staged Suggestions mutation and checks declared sources through readback.
 * WHY: Keeps success bound to byte-identical authoring and storage evidence.
 */
export async function sendSuggestionsRequest({
  baseUrl = process.env.SUGGEST_BASE_URL,
  path,
  method,
  bodyFile,
  expectFiles = [],
  readPath = null,
  token,
  requestHeaders = {},
  stateDir = join(homedir(), ".agentmux", "suggestions-authoring-outbox"),
  fetchImpl = fetch,
  warn = (message) => console.warn(message),
}) {
  const upperMethod = String(method ?? "").toUpperCase();
  if (!MUTATING_METHODS.has(upperMethod)) {
    throw new Error(`method must be one of ${[...MUTATING_METHODS].join(", ")}`);
  }
  if (!token) throw new Error("Suggestions credential is empty");
  const base = new URL(normalizeServiceBaseUrl(baseUrl, "Suggestions base URL", {
    allowHttpLoopback: process.env.NODE_ENV === "test",
  }));
  const target = new URL(path, base);
  if (target.origin !== base.origin || !target.pathname.startsWith("/api/")) {
    throw new Error("request path must stay under the configured /api/ origin");
  }
  if (expectFiles.length > 0 && !readPath) {
    throw new Error("--read-path is required when --expect-file is used");
  }
  const bodyBytes = readFileSync(resolve(bodyFile));
  const expectedBytes = expectFiles.map((file) => readFileSync(resolve(file)));
  const expected = assertVerbatimSources(bodyBytes, expectedBytes);
  if (Object.keys(requestHeaders).some((name) => name.toLowerCase() !== "x-agent-id")) {
    throw new Error("only X-Agent-ID may be added to a Suggestions request");
  }
  // AI-0026. Deliberately BEFORE staging: this warns today, but the day it
  // rejects it must refuse without leaving an envelope behind, or a send that
  // was never meant to happen becomes indistinguishable from one that failed.
  // That is the ambiguity #284 removed, and it is one line away from returning.
  const manglingWarning = describeManglingRisk(
    findManglingRiskInPayload(parseJsonBytes(bodyBytes, "request body").value),
  );
  if (manglingWarning) warn(manglingWarning);
  const staged = stageSuggestionsRequest({
    bodyBytes, method: upperMethod, url: target.href, stateDir: resolve(stateDir),
  });
  const headers = {
    ...requestHeaders,
    authorization: `Bearer ${token}`,
    "content-type": "application/json; charset=utf-8",
    "user-agent": "curl/7.81.0 amux-suggest/1",
  };
  // Every exit past this point records what the attempt did, because the file
  // is the only durable account of it. Leaving a failed attempt at "staged"
  // makes it indistinguishable from one that never left the machine — and the
  // two need opposite handling: replay the unsent, never replay the rejected,
  // verify the ones whose response was lost. Measured 2026-08-04: 193 envelopes
  // sat at "staged" with no way to tell those three apart.
  const recordAttempt = (state, extra) => {
    const persisted = JSON.parse(readFileSync(staged.metadataPath, "utf8"));
    atomicJson(staged.metadataPath, {
      ...persisted, state, attemptedAt: new Date().toISOString(), ...extra,
    });
    return persisted;
  };
  let response;
  try {
    response = await fetchImpl(target, {
      method: upperMethod, headers, body: staged.bodyBytes,
    });
  }
  catch (error) {
    // The server may or may not have applied it; only a readback can say.
    recordAttempt("send_failed", { lastStatus: null, lastError: String(error.message ?? error) });
    throw error;
  }
  const responseBytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    const detail = failureDetail(strictUtf8(responseBytes));
    recordAttempt("rejected", { lastStatus: response.status, lastError: detail });
    throw new Error(`Suggestions mutation HTTP ${response.status}: ${detail}`);
  }
  if (readPath) {
    const readTarget = new URL(readPath, base);
    if (readTarget.origin !== base.origin || !readTarget.pathname.startsWith("/api/")) {
      throw new Error("read path must stay under the configured /api/ origin");
    }
    const readback = await fetchImpl(readTarget, { headers: { authorization: `Bearer ${token}` } });
    const readBytes = Buffer.from(await readback.arrayBuffer());
    // The mutation itself already succeeded, so this is NOT a replay candidate:
    // resending would apply it twice, and comments have no delete route.
    if (!readback.ok) {
      recordAttempt("applied_unverified",
        { lastStatus: response.status, lastError: `readback HTTP ${readback.status}` });
      throw new Error(`Suggestions readback HTTP ${readback.status}`);
    }
    try { assertReadback(readBytes, expected); }
    catch (error) {
      recordAttempt("applied_unverified",
        { lastStatus: response.status, lastError: String(error.message ?? error) });
      throw error;
    }
  }
  const metadata = recordAttempt("acknowledged", {
    acknowledgedAt: new Date().toISOString(),
    lastStatus: response.status,
    responseHash: sha256(responseBytes),
  });
  return {
    mutationId: staged.mutationId,
    replay: staged.replay,
    status: response.status,
    responseText: strictUtf8(responseBytes, "mutation response"),
    requestHash: metadata.requestHash,
    persistedBody: staged.bodyPath,
  };
}

/**
 * WHAT: Resolves the default Suggestions credential file.
 * WHY: Keeps credentials out of command arguments and request payload files.
 */
export function defaultSuggestionsTokenFile() {
  return join(homedir(), ".config", "agent", "suggestions-admin-token");
}

/** WHAT: Resolves the shared fleet key used by the simple pull workflow. WHY: Keeps it out of argv and shell history. */
export function defaultSuggestionsFleetKeyFile() {
  return join(homedir(), ".config", "agent", "suggestions-fleet-key");
}

/**
 * WHAT: Formats a request body filename for receipt output.
 * WHY: Keeps receipts useful without exposing the caller's local directory.
 */
export function displayBodyFile(path) {
  return basename(path);
}
