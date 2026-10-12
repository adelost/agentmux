// Durable human-directive journal.
//
// Session JSONL is an execution log, not an archive: providers rotate it and
// agentmux deliberately reaps expired files. Every inbound prompt is therefore
// captured here before transport/classification. The current file may rotate,
// but rotations are renamed beside it and readers include every archive.

import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseJsonlText } from "./jsonl-reader.mjs";
import { authoredPromptText } from "./system-noise.mjs";

/** WHAT: Defines the on-disk ask row schema. WHY: Keeps future readers from guessing incompatible records. */
export const ASK_LEDGER_VERSION = 1;
/** WHAT: Defines one active ask journal limit. WHY: Keeps history in archives instead of one giant file. */
export const DEFAULT_ASK_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
const ROTATION_LOCK_SUFFIX = ".rotate.lock";

/** WHAT: Resolves the durable ask journal. WHY: Keeps every producer on one user-scoped archive. */
export function defaultAskLedgerPath(home = homedir()) {
  return process.env.AMUX_ASK_LEDGER_PATH || join(home, ".agentmux", "ask-ledger.jsonl");
}

const iso = (value) => {
  const parsed = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
};

const entryId = (entry) => createHash("sha256").update([
  entry.ts,
  entry.agent,
  entry.pane,
  entry.source,
  entry.verbatim,
  entry.sessionId || "",
].join("\u0000")).digest("hex");

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch {}
}

function rotateBeforeAppend(path, { nowMs, maxBytes }) {
  let size = 0;
  try { size = statSync(path).size; } catch { return null; }
  if (size < maxBytes) return null;

  const lock = `${path}${ROTATION_LOCK_SUFFIX}`;
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch { return null; }
  try {
    try { size = statSync(path).size; } catch { return null; }
    if (size < maxBytes) return null;
    const stamp = new Date(nowMs).toISOString().replace(/[:.]/gu, "-");
    const archive = join(
      dirname(path),
      `${basename(path, ".jsonl")}.${stamp}.${process.pid}.${randomUUID()}.jsonl`,
    );
    renameSync(path, archive);
    return archive;
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch {}
  }
}

function appendLedgerRow(row, { path, nowMs, maxBytes }) {
  ensurePrivateDirectory(dirname(path));
  rotateBeforeAppend(path, { nowMs, maxBytes });
  appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

// Failure remains visible to the caller so transport cannot outrun memory.
/** WHAT: Stores one exact prompt observation. WHY: Keeps delivery from proceeding after a failed memory write. */
export function appendAskLedger(entry, {
  path = defaultAskLedgerPath(),
  now = () => Date.now(),
  maxBytes = Number(process.env.AMUX_ASK_LEDGER_MAX_BYTES) || DEFAULT_ASK_LEDGER_MAX_BYTES,
} = {}) {
  if (!String(entry?.agent || "").trim()) throw new Error("ask ledger requires agent");
  if (!Number.isSafeInteger(Number(entry?.pane)) || Number(entry.pane) < 0) {
    throw new Error("ask ledger requires a non-negative pane");
  }
  if (typeof entry?.verbatim !== "string" || !entry.verbatim.trim()) {
    throw new Error("ask ledger requires non-empty verbatim text");
  }

  const nowMs = Number(now());
  const normalized = {
    version: ASK_LEDGER_VERSION,
    event: "ask",
    ts: iso(entry.ts ?? nowMs),
    agent: String(entry.agent),
    pane: Number(entry.pane),
    source: String(entry.source || "unknown"),
    verbatim: entry.verbatim,
    sessionFile: entry.sessionFile ? String(entry.sessionFile) : null,
    sessionId: entry.sessionId ? String(entry.sessionId) : null,
    cwd: entry.cwd ? String(entry.cwd) : null,
    repo: entry.repo ? String(entry.repo) : String(entry.agent),
    deliveryId: entry.deliveryId ? String(entry.deliveryId) : null,
    deliveryPath: entry.deliveryPath ? String(entry.deliveryPath) : null,
    deliveryStatus: entry.deliveryStatus ? String(entry.deliveryStatus) : null,
    origin: entry.origin ? String(entry.origin) : null,
    sender: entry.sender ? String(entry.sender) : null,
    backfilled: entry.backfilled === true,
    completionStatus: entry.completionStatus ? String(entry.completionStatus) : null,
    completionReply: entry.completionReply ? String(entry.completionReply) : null,
    completionAt: entry.completionAt ? String(entry.completionAt) : null,
    completionSessionFile: entry.completionSessionFile
      ? String(entry.completionSessionFile)
      : null,
  };
  normalized.id = String(entry.id || entryId(normalized));
  appendLedgerRow(normalized, { path, nowMs, maxBytes });
  return { ...normalized, ledgerPath: path };
}

/** WHAT: Names what one Discord post was. WHY: Keeps notices and mirrored prompts from reading as an agent's answer. */
export const POST_KINDS = Object.freeze(["reply", "mirror", "file", "voice", "notice"]);
/** WHAT: Defines the largest stored post text. WHY: A Discord message holds at most 2000 characters; only a pathological payload reaches this. */
export const POST_TEXT_MAX_BYTES = 64 * 1024;

/** WHAT: Reduces a Discord payload to its text and attached files. WHY: Keeps the string and {content, files} transport shapes in one row form. */
export function discordPostContent(payload) {
  if (typeof payload === "string") return { text: payload, files: [] };
  const files = (Array.isArray(payload?.files) ? payload.files : []).map((file) => {
    if (typeof file === "string") return file;
    if (typeof file?.attachment === "string") return file.attachment;
    return String(file?.name || "attachment");
  });
  return { text: typeof payload?.content === "string" ? payload.content : "", files };
}

function clipPostText(text, maxBytes) {
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxBytes) return { text };
  return { text: Buffer.from(text).subarray(0, maxBytes).toString("utf8"), truncated: true, textBytes: bytes };
}

/** WHAT: Names the outcomes of a send attempt. WHY: A failed send is a row, not a silence. */
export const POST_STATUSES = Object.freeze(["sent", "failed"]);

/** WHAT: Stores one send attempt to Discord. WHY: Keeps replies, mirrored sends, posted files and failed sends readable without provider journals. */
export function appendPost(entry, {
  path = defaultAskLedgerPath(),
  now = () => Date.now(),
  maxBytes = Number(process.env.AMUX_ASK_LEDGER_MAX_BYTES) || DEFAULT_ASK_LEDGER_MAX_BYTES,
  maxTextBytes = POST_TEXT_MAX_BYTES,
} = {}) {
  if (!String(entry?.channelId || "").trim()) throw new Error("post ledger requires a channel");
  if (!["bridge", "cli"].includes(entry?.via)) throw new Error("post ledger requires via bridge or cli");
  const { text, files } = discordPostContent(entry.payload);
  if (!text.trim() && !files.length) return null;
  const kind = entry.kind ?? (files.length && !text.trim() ? "file" : "notice");
  if (!POST_KINDS.includes(kind)) throw new Error(`unknown post kind '${kind}'`);
  const status = entry.status ?? "sent";
  if (!POST_STATUSES.includes(status)) throw new Error(`unknown post status '${status}'`);
  const nowMs = Number(now());
  const pane = Number(entry.pane);
  const row = {
    version: ASK_LEDGER_VERSION,
    event: "post",
    ts: iso(entry.ts ?? nowMs),
    agent: entry.agent ? String(entry.agent) : null,
    pane: entry.agent && Number.isSafeInteger(pane) && pane >= 0 ? pane : null,
    channelId: String(entry.channelId),
    via: entry.via,
    kind,
    ...clipPostText(text, maxTextBytes),
    files,
    status,
    ...(status === "failed" ? { error: String(entry.error || "unknown").slice(0, 500) } : {}),
    messageId: entry.messageId ? String(entry.messageId) : null,
    deliveryId: entry.deliveryId ? String(entry.deliveryId) : null,
  };
  row.id = createHash("sha256").update([row.ts, row.channelId, row.messageId || "", status, row.text, ...files, randomUUID()]
    .join("\u0000")).digest("hex");
  appendLedgerRow(row, { path, nowMs, maxBytes });
  return row;
}

/** WHAT: Stores a provider's exact submitted prompt. WHY: Keeps event classification from discarding ask identity. */
export function capturePaneHookAsk(payload, pane, options = {}) {
  if (payload?.hook_event_name !== "UserPromptSubmit" || !pane) return null;
  if (typeof payload.prompt !== "string" || !payload.prompt.trim()) return null;
  return appendAskLedger({
    ts: payload.ts || payload.timestamp,
    agent: pane.session,
    pane: pane.pane,
    source: "pane-hook",
    verbatim: payload.prompt,
    sessionFile: payload.transcript_path || null,
    sessionId: payload.session_id || null,
    cwd: payload.cwd || null,
    repo: pane.session,
  }, options);
}

/** WHAT: Stores one brokered delivery before queue classification. WHY: Keeps transport retries from creating unremembered prompts. */
export function captureDeliveryAsk({
  agentName, pane, text, source, metadata, id, createdAtMs,
}, { recordAsk = appendAskLedger, path = defaultAskLedgerPath(), now = () => Date.now() } = {}) {
  return recordAsk({
    id: `delivery:${id}`,
    ts: new Date(createdAtMs).toISOString(),
    agent: agentName,
    pane,
    source,
    verbatim: String(text),
    sessionFile: metadata?.sessionFile || null,
    sessionId: metadata?.sessionId || null,
    cwd: metadata?.cwd || null,
    repo: metadata?.repo || agentName,
    deliveryId: id,
  }, { path, now });
}

/** WHAT: Resolves current and renamed ask journals. WHY: Keeps rotation from hiding old directives. */
function askLedgerFiles(path = defaultAskLedgerPath()) {
  const dir = dirname(path);
  const current = basename(path);
  const prefix = `${basename(path, ".jsonl")}.`;
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => name === current || (name.startsWith(prefix) && name.endsWith(".jsonl")))
    .sort((left, right) => (left === current ? 1 : right === current ? -1 : left.localeCompare(right)))
    .map((name) => join(dir, name));
}

/** WHAT: Reads current and archived ask rows. WHY: Keeps one torn line from hiding healthy history. */
export function readAskLedger({ path = defaultAskLedgerPath(), readFile = null } = {}) {
  const load = readFile || ((file) => readFileSync(file, "utf8"));
  const rows = [];
  for (const file of askLedgerFiles(path)) {
    let text = "";
    try { text = load(file); } catch { continue; }
    for (const row of parseJsonlText(String(text || ""))) {
      if (row?.event !== "ask" || row?.version !== ASK_LEDGER_VERSION
          || typeof row.verbatim !== "string") continue;
      rows.push({ ...row, ledgerPath: file });
    }
  }
  return coalesceAskLedger(rows);
}

function rotatedAtMs(file) {
  const match = basename(file).match(/\.(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\./u);
  return match ? Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) : NaN;
}

// Every row is written as {"version":N,"event":"...","ts":"..."...}, so a row's time sits at its start.
const ROW_TIME = /^\{"version":\d+,"event":"[a-z]+","ts":"([^"]+)"/u;
const SPAN_PROBE_BYTES = 64 * 1024;

function readSlice(file, fromEnd) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = statSync(file).size;
    const length = Math.min(size, SPAN_PROBE_BYTES);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
    return { text: buffer.toString("utf8", 0, read), whole: length === size };
  } catch { return { text: "", whole: false }; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function rowTimes(text, { skipFirst }) {
  return text.split("\n").slice(skipFirst ? 1 : 0)
    .map((line) => Date.parse(line.match(ROW_TIME)?.[1] || "")).filter(Number.isFinite);
}

/**
 * WHAT: Lists the ledger files with the time span each holds, from their first and last rows.
 * WHY: Lets a window read open only the archives it overlaps. Rows are appended in about time order;
 * an unreadable edge widens the span instead of hiding the file.
 */
function ledgerSpans(path) {
  const current = resolve(path);
  return askLedgerFiles(path).map((file) => {
    const head = readSlice(file, false);
    const tail = readSlice(file, true);
    const firstMs = rowTimes(head.text, { skipFirst: false })[0] ?? -Infinity;
    // A renamed archive's rows predate its rotation stamp; the current file still grows.
    const lastMs = resolve(file) === current ? Infinity
      : rowTimes(tail.text, { skipFirst: !tail.whole }).at(-1) ?? (rotatedAtMs(file) || Infinity);
    return { file, firstMs, lastMs };
  });
}

/** WHAT: Reports the size of the current file and each archive. WHY: Shows how fast the log grows without handing out its files. */
export function ledgerFileSizes(path = defaultAskLedgerPath()) {
  const current = resolve(path);
  return askLedgerFiles(path).map((file) => {
    let bytes = 0;
    try { bytes = statSync(file).size; } catch {}
    return { current: resolve(file) === current, bytes };
  });
}

const toMs = (value, fallback) => (value == null ? fallback : value instanceof Date ? value.getTime()
  : typeof value === "number" ? value : Date.parse(value));
const byTimeThenId = (left, right) => Date.parse(left.ts) - Date.parse(right.ts) || String(left.id).localeCompare(String(right.id));

/**
 * WHAT: Reads the asks and posts in one time window, opening only the files that overlap it.
 * WHY: Gives Dream, asks, revive and timelines one reader of the conversation log; no other module parses the file.
 * coverageStartMs is the first post seen in the opened files: posts are trusted only from there on.
 */
export function readWindow({ path = defaultAskLedgerPath(), since = null, until = null, agents = null, readFile = null } = {}) {
  const sinceMs = toMs(since, -Infinity);
  const untilMs = toMs(until, Infinity);
  const wanted = agents ? new Set(agents) : null;
  const load = readFile || ((file) => readFileSync(file, "utf8"));
  const asks = [];
  const posts = [];
  const files = [];
  let coverageStartMs = Infinity;
  for (const span of ledgerSpans(path)) {
    if (span.lastMs < sinceMs || span.firstMs > untilMs) continue;
    let text = "";
    try { text = load(span.file); } catch { continue; }
    files.push(span.file);
    for (const row of parseJsonlText(String(text || ""))) {
      if (row?.version !== ASK_LEDGER_VERSION) continue;
      const ms = Date.parse(row.ts);
      const isPost = row.event === "post" && typeof row.text === "string";
      if (isPost) coverageStartMs = Math.min(coverageStartMs, ms);
      if (!(ms > sinceMs && ms <= untilMs) || (wanted && !wanted.has(row.agent))) continue;
      if (row.event === "ask" && typeof row.verbatim === "string") asks.push({ ...row, ledgerPath: span.file });
      else if (isPost) posts.push(row);
    }
  }
  return { asks: coalesceAskLedger(asks), posts: posts.sort(byTimeThenId), coverageStartMs, files };
}

const PERSISTABLE_COMPLETION_STATUSES = new Set(["done", "answered"]);

/** WHAT: Freezes live terminal ask evidence into the durable ledger. WHY: A later compact/respawn must not turn known-complete work back into unknown history. */
export function persistAskCompletionEvidence({
  ledgerEntries = [],
  joinedEntries = [],
  path = defaultAskLedgerPath(),
  recordAsk = appendAskLedger,
  now = () => Date.now(),
} = {}) {
  const byId = new Map(ledgerEntries.map((entry) => [entry.id, entry]));
  let persisted = 0;
  for (const row of joinedEntries) {
    if (!row?.ledgerId
        || !row.jsonlFile
        || !PERSISTABLE_COMPLETION_STATUSES.has(row.status)) continue;
    const ledger = byId.get(row.ledgerId);
    if (!ledger || ledger.completionStatus) continue;
    recordAsk({
      ...ledger,
      id: ledger.id,
      completionStatus: row.status,
      completionReply: row.replyPreview || row.reply || "",
      completionAt: row.endTimestamp || row.timestamp || new Date(now()).toISOString(),
      completionSessionFile: row.jsonlFile,
    }, { path, now });
    ledger.completionStatus = row.status;
    persisted++;
  }
  return persisted;
}

// Delivery owns identity; the matching hook contributes its concrete session
// pointer. Direct typed prompts remain standalone hook rows.
/** WHAT: Maps duplicate producer observations to one ask. WHY: Keeps delivery and pane-hook capture from rendering duplicates. */
export function coalesceAskLedger(entries, { hookMatchMs = 15 * 60 * 1000 } = {}) {
  const unique = new Map();
  for (const row of [...entries].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))) {
    const previous = unique.get(row.id);
    unique.set(row.id, previous ? {
      ...previous,
      sessionFile: previous.sessionFile || row.sessionFile || null,
      sessionId: previous.sessionId || row.sessionId || null,
      cwd: previous.cwd || row.cwd || null,
      repo: previous.repo || row.repo || previous.agent,
      deliveryPath: previous.deliveryPath || row.deliveryPath || null,
      deliveryStatus: previous.deliveryStatus || row.deliveryStatus || null,
      origin: previous.origin || row.origin || null,
      sender: previous.sender || row.sender || null,
      backfilled: previous.backfilled || row.backfilled || false,
      completionStatus: previous.completionStatus || row.completionStatus || null,
      completionReply: previous.completionReply || row.completionReply || null,
      completionAt: previous.completionAt || row.completionAt || null,
      completionSessionFile: previous.completionSessionFile
        || row.completionSessionFile
        || null,
    } : { ...row });
  }

  const rows = [...unique.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const deliveries = rows.filter((row) => row.source !== "pane-hook");
  const deliveriesBySameAsk = groupBySameAsk(deliveries);
  const standaloneHooks = [];
  const claimed = new Set();
  for (const hook of rows.filter((row) => row.source === "pane-hook")) {
    const hookAt = Date.parse(hook.ts);
    const candidate = (deliveriesBySameAsk.get(sameAskKey(hook)) || [])
      .filter((row) => !claimed.has(row.id)
        && row.agent === hook.agent
        && row.pane === hook.pane
        && authoredPromptText(row.verbatim) === authoredPromptText(hook.verbatim)
        && Math.abs(hookAt - Date.parse(row.ts)) <= hookMatchMs)
      .sort((a, b) => Math.abs(hookAt - Date.parse(a.ts)) - Math.abs(hookAt - Date.parse(b.ts)))[0];
    if (!candidate) {
      standaloneHooks.push(hook);
      continue;
    }
    candidate.sessionFile = candidate.sessionFile || hook.sessionFile;
    candidate.sessionId = candidate.sessionId || hook.sessionId;
    candidate.cwd = candidate.cwd || hook.cwd;
    candidate.repo = hook.repo || candidate.repo;
    claimed.add(candidate.id);
  }
  return [...deliveries, ...standaloneHooks].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

// A hook can only fold into a delivery of the same agent, pane and text, so it
// is compared with that group instead of with every delivery in the ledger.
// The key may merge values such as pane 1 and "1"; the exact checks decide.
const sameAskKey = (row) => `${row.agent}\u0000${row.pane}\u0000${authoredPromptText(row.verbatim)}`;

function groupBySameAsk(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = sameAskKey(row);
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}
