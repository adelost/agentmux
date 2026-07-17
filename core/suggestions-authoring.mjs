import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
const PUBLIC_SUGGESTIONS_HOST = /https:\/\/(?:suggest|suggestions)\.v1d\.io\/api\//iu;
const MUTATING_SHELL = /(?:\b(?:curl|wget)\b[\s\S]*(?:\s-X\s*|--request(?:=|\s+)|\s-(?:d|F)\s|--data(?:-binary|raw|urlencode)?(?:=|\s+)|--form(?:=|\s+))|\b(?:fetch|Request)\s*\([\s\S]*?\bmethod\s*[:=]\s*["']?(?:POST|PATCH|PUT|DELETE))/iu;
const CANONICAL_CLIENT = /(?:^|[;&|]\s*)(?:env\s+)?(?:node\s+\S*\/)?amux-suggest(?:\.mjs)?(?:\s|$)/mu;

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * WHAT: Checks direct Suggestions mutations for bypasses of the canonical file writer.
 * WHY: Keeps agent-authored human text behind exact UTF-8 verification before transport.
 */
export function inspectSuggestionsMutationCommand(command) {
  const text = String(command ?? "");
  if (!PUBLIC_SUGGESTIONS_HOST.test(text) || !MUTATING_SHELL.test(text)) {
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
    const source = strictUtf8(bytes, `verbatim source ${index + 1}`);
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
  baseUrl = "https://suggest.v1d.io",
  path,
  method,
  bodyFile,
  expectFiles = [],
  readPath = null,
  token,
  stateDir = join(homedir(), ".agentmux", "suggestions-authoring-outbox"),
  fetchImpl = fetch,
}) {
  const upperMethod = String(method ?? "").toUpperCase();
  if (!MUTATING_METHODS.has(upperMethod)) {
    throw new Error(`method must be one of ${[...MUTATING_METHODS].join(", ")}`);
  }
  if (!token) throw new Error("Suggestions credential is empty");
  const base = new URL(baseUrl);
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
  const staged = stageSuggestionsRequest({
    bodyBytes, method: upperMethod, url: target.href, stateDir: resolve(stateDir),
  });
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json; charset=utf-8",
    "user-agent": "curl/7.81.0 amux-suggest/1",
  };
  const response = await fetchImpl(target, {
    method: upperMethod, headers, body: staged.bodyBytes,
  });
  const responseBytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`Suggestions mutation HTTP ${response.status}: ${strictUtf8(responseBytes).slice(0, 500)}`);
  }
  if (readPath) {
    const readTarget = new URL(readPath, base);
    if (readTarget.origin !== base.origin || !readTarget.pathname.startsWith("/api/")) {
      throw new Error("read path must stay under the configured /api/ origin");
    }
    const readback = await fetchImpl(readTarget, { headers: { authorization: `Bearer ${token}` } });
    const readBytes = Buffer.from(await readback.arrayBuffer());
    if (!readback.ok) throw new Error(`Suggestions readback HTTP ${readback.status}`);
    assertReadback(readBytes, expected);
  }
  const metadata = JSON.parse(readFileSync(staged.metadataPath, "utf8"));
  atomicJson(staged.metadataPath, {
    ...metadata,
    state: "acknowledged",
    acknowledgedAt: new Date().toISOString(),
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

/**
 * WHAT: Formats a request body filename for receipt output.
 * WHY: Keeps receipts useful without exposing the caller's local directory.
 */
export function displayBodyFile(path) {
  return basename(path);
}
