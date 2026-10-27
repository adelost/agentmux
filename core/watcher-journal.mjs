// Watcher records that change on every post or tool step, kept out of agentmux-state.json.
// On 27 Oct they made the bridge rewrite that 2.3 MB file about once a second, with an
// fsync each time (10-13 MB/s, about 1 TB a day). Each change is now one appended line;
// a restart reads the capped file back. Without a state file path (tests) it stays in memory.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE_NAME = "watcher-journal.jsonl";
const MAX_BYTES = 2 * 1024 * 1024;
const POSTED_KEEP = 1_000; // the watcher engine keeps the same number of posted ids
const MOVED_KEYS = { posted: "watcher_posted_item_ids", work: "watcher_live_progress" };
const DROPPED_KEYS = ["watcher_changed_files"]; // now kept in memory by live progress
const journals = new WeakMap(); // state store → journal, shared by every watcher of a process

/**
 * WHAT: Returns the watcher journal of one state store, created on first use.
 * WHY: Keeps per-post and per-step watcher records from rewriting the shared state file.
 */
export function openWatcherJournal({ state, maxBytes = MAX_BYTES, log = console.warn } = {}) {
  if (!state) throw new Error("watcher journal: state store required");
  if (!journals.has(state)) journals.set(state, createJournal(state, maxBytes, log));
  return journals.get(state);
}

function createJournal(state, maxBytes, log) {
  const path = state.path ? join(dirname(state.path), FILE_NAME) : null;
  const channels = new Map(); // channelId → { work, posted }
  const entry = (id) => channels.get(id) || channels.set(id, { work: null, posted: [] }).get(id);
  const apply = (line) => {
    const current = entry(line.c);
    if ("work" in line) current.work = line.work;
    if (line.posted) current.posted = [...current.posted, ...line.posted].slice(-POSTED_KEEP);
    if (line.postedAll) current.posted = line.postedAll.slice(-POSTED_KEEP);
  };
  let size = 0, limit = maxBytes; // a snapshot near the cap must not compact on every append
  const snapshot = () => [...channels].map(([c, { work, posted }]) => JSON.stringify({ c, work, postedAll: posted })).join("\n") + "\n";
  const compact = () => {
    if (!path) return;
    const text = snapshot(), temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 });
    renameSync(temp, path);
    size = Buffer.byteLength(text);
    limit = Math.max(maxBytes, 2 * size);
  };
  const append = (line) => {
    apply(line);
    if (!path) return;
    const text = `${JSON.stringify(line)}\n`;
    appendFileSync(path, text, { mode: 0o600 });
    size += Buffer.byteLength(text);
    if (size > limit) compact();
  };

  if (path && existsSync(path)) {
    const text = readFileSync(path, "utf8");
    size = Buffer.byteLength(text);
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      try { apply(JSON.parse(raw)); }
      catch { log(`watcher journal ${path}: skipped an unreadable line (${raw.length} chars)`); }
    }
  } else {
    // First run: carry the records over from the state file, then drop them there once.
    for (const [c, ids] of Object.entries(state.get(MOVED_KEYS.posted, {}) || {})) if (Array.isArray(ids)) apply({ c, postedAll: ids });
    for (const [c, row] of Object.entries(state.get(MOVED_KEYS.work, {}) || {})) {
      if (row?.messageId) apply({ c, work: persistedWork(row) });
    }
    compact();
    for (const key of [...Object.values(MOVED_KEYS), ...DROPPED_KEYS]) {
      if (state.get(key) === undefined) continue;
      if (typeof state.remove === "function") state.remove(key); else state.set(key, undefined);
    }
  }

  return {
    work: (channelId) => channels.get(channelId)?.work || null,
    setWork(channelId, row) {
      const next = row ? persistedWork(row) : null;
      if (JSON.stringify(channels.get(channelId)?.work || null) !== JSON.stringify(next)) append({ c: channelId, work: next });
    },
    posted: (channelId) => [...(channels.get(channelId)?.posted || [])],
    setPosted(channelId, ids) {
      const prior = channels.get(channelId)?.posted || [], next = (Array.isArray(ids) ? ids : []).slice(-POSTED_KEEP);
      const known = new Set(prior), added = next.filter((id) => !known.has(id));
      const kept = next.slice(0, next.length - added.length);
      if (!added.length && kept.length === prior.length) return;
      // Ids only appended (older ones trimmed) take one short line; any other change rewrites the set.
      const appendOnly = kept.every((id, i) => id === prior[prior.length - kept.length + i]);
      append(appendOnly && added.length ? { c: channelId, posted: added } : { c: channelId, postedAll: next });
    },
  };
}

const persistedWork = (row) => ({ messageId: row.messageId, turnKey: row.turnKey, ...(row.finishing ? { finishing: true } : {}) });
