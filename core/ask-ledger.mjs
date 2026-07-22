// Durable human-directive journal.
//
// Session JSONL is an execution log, not an archive: providers rotate it and
// agentmux deliberately reaps expired files. Every inbound prompt is therefore
// captured here before transport/classification. The current file may rotate,
// but rotations are renamed beside it and readers include every archive.

import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { parseJsonlText } from "./jsonl-reader.mjs";

export const ASK_LEDGER_VERSION = 1;
export const DEFAULT_ASK_LEDGER_MAX_BYTES = 32 * 1024 * 1024;
const ROTATION_LOCK_SUFFIX = ".rotate.lock";

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

/**
 * Append one exact prompt observation. A write failure is intentionally
 * visible to the caller: delivery must not proceed when its memory write did
 * not, otherwise the very failure this ledger exists for returns silently.
 */
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
  ensurePrivateDirectory(dirname(path));
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
  };
  normalized.id = String(entry.id || entryId(normalized));

  rotateBeforeAppend(path, { nowMs, maxBytes });
  appendFileSync(path, `${JSON.stringify(normalized)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
  return { ...normalized, ledgerPath: path };
}

/** Capture the provider's exact submitted prompt before event classification. */
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

export function askLedgerFiles(path = defaultAskLedgerPath()) {
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

/** Read current + archived rows, tolerating torn/corrupt lines. */
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

/**
 * Delivery and pane-hook both see brokered prompts. Keep the delivery record
 * as identity and fold the hook's concrete transcript pointer into it. Direct
 * typed prompts have no delivery twin and remain standalone hook records.
 */
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
    } : { ...row });
  }

  const rows = [...unique.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const deliveries = rows.filter((row) => row.source !== "pane-hook");
  const standaloneHooks = [];
  const claimed = new Set();
  for (const hook of rows.filter((row) => row.source === "pane-hook")) {
    const hookAt = Date.parse(hook.ts);
    const candidate = deliveries
      .filter((row) => !claimed.has(row.id)
        && row.agent === hook.agent
        && row.pane === hook.pane
        && row.verbatim === hook.verbatim
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
