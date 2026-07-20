import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AUDIO_EVENT_SCHEMA_VERSION = 1;
export const AUDIO_EVENT_TTL_MS = 10 * 60 * 1000;
export const AUDIO_REPLAY_LIMIT = 100;
export const AUDIO_RECEIPT_STATES = Object.freeze([
  "received",
  "queued",
  "playback-started",
  "played",
  "failed",
]);

const TERMINAL_OR_AMBIGUOUS = new Set(["playback-started", "played", "failed"]);
const RECEIPT_TRANSITIONS = new Map([
  [null, new Set(["received"])],
  ["received", new Set(["queued", "failed"])],
  ["queued", new Set(["playback-started", "failed"])],
  ["playback-started", new Set(["played", "failed"])],
  ["played", new Set()],
  ["failed", new Set()],
]);
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 1500;
const LOCK_TIMEOUT_MS = 2000;
const STALE_LOCK_MS = 30_000;

export function defaultAudioOutboxPath() {
  return process.env.AMUX_AUDIO_OUTBOX_PATH
    || join(homedir(), ".agentmux", "audio-outbox-v1.jsonl");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock(journalPath, operation) {
  mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 });
  const lockPath = `${journalPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) throw new Error("audio outbox is busy");
      sleepSync(20);
    }
  }

  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function durableAppend(path, record) {
  const fd = openSync(path, "a", 0o600);
  try {
    appendFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function parseJournal(path) {
  const events = new Map();
  const receipts = new Map();
  if (!existsSync(path)) return { events, receipts };

  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.schemaVersion !== AUDIO_EVENT_SCHEMA_VERSION) continue;
    if (record.kind === "event" && record.event?.eventId) {
      events.set(record.event.eventId, record.event);
    } else if (record.kind === "receipt" && record.receipt?.eventId) {
      const key = `${record.receipt.consumerId}:${record.receipt.eventId}`;
      const history = receipts.get(key) || [];
      history.push(record.receipt);
      receipts.set(key, history);
    }
  }
  return { events, receipts };
}

function compactIfNeeded(path, snapshot, nowMs) {
  if (!existsSync(path) || statSync(path).size <= MAX_JOURNAL_BYTES) return;
  const retainedEvents = [...snapshot.events.values()]
    .filter((event) => Date.parse(event.expiresAt) > nowMs - 24 * 60 * 60 * 1000)
    .slice(-500);
  const retainedIds = new Set(retainedEvents.map((event) => event.eventId));
  const rows = retainedEvents.map((event) => ({
    schemaVersion: AUDIO_EVENT_SCHEMA_VERSION,
    kind: "event",
    event,
  }));
  for (const history of snapshot.receipts.values()) {
    for (const receipt of history) {
      if (retainedIds.has(receipt.eventId)) {
        rows.push({
          schemaVersion: AUDIO_EVENT_SCHEMA_VERSION,
          kind: "receipt",
          receipt,
        });
      }
    }
  }
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  const fd = openSync(tempPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, path);
}

function validateIdentity(value, label) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_.:@-]{1,160}$/.test(normalized)) {
    throw new Error(`${label} must be 1-160 safe identity characters`);
  }
  return normalized;
}

function targetId(target) {
  if (typeof target === "string") return validateIdentity(target, "target");
  return validateIdentity(target?.id, "target.id");
}

export function createAudioOutbox({
  journalPath = defaultAudioOutboxPath(),
  now = () => new Date(),
  id = randomUUID,
} = {}) {
  function publish({ text, target, eventId = id(), ttlMs = AUDIO_EVENT_TTL_MS }) {
    const clean = String(text || "").trim().slice(0, MAX_TEXT_CHARS);
    if (!clean) throw new Error("audio event text is empty");
    const safeEventId = validateIdentity(eventId, "eventId");
    const safeTarget = targetId(target);
    const createdAtDate = now();
    const ttl = Math.max(1000, Math.min(AUDIO_EVENT_TTL_MS, Number(ttlMs) || AUDIO_EVENT_TTL_MS));
    const event = {
      schemaVersion: AUDIO_EVENT_SCHEMA_VERSION,
      eventId: safeEventId,
      text: clean,
      createdAt: createdAtDate.toISOString(),
      expiresAt: new Date(createdAtDate.getTime() + ttl).toISOString(),
      target: { type: "discord-channel", id: safeTarget },
    };

    return withFileLock(journalPath, () => {
      const snapshot = parseJournal(journalPath);
      const existing = snapshot.events.get(safeEventId);
      if (existing) return { event: existing, duplicate: true };
      durableAppend(journalPath, {
        schemaVersion: AUDIO_EVENT_SCHEMA_VERSION,
        kind: "event",
        event,
      });
      snapshot.events.set(safeEventId, event);
      compactIfNeeded(journalPath, snapshot, createdAtDate.getTime());
      return { event, duplicate: false };
    });
  }

  function receipt({ eventId, consumerId, state, detail = null }) {
    const safeEventId = validateIdentity(eventId, "eventId");
    const safeConsumerId = validateIdentity(consumerId, "consumerId");
    if (!AUDIO_RECEIPT_STATES.includes(state)) {
      throw new Error(`receipt state must be one of ${AUDIO_RECEIPT_STATES.join(", ")}`);
    }
    const cleanDetail = detail == null ? null : String(detail).trim().slice(0, 300);
    const at = now().toISOString();

    return withFileLock(journalPath, () => {
      const snapshot = parseJournal(journalPath);
      if (!snapshot.events.has(safeEventId)) throw new Error("audio event not found");
      const key = `${safeConsumerId}:${safeEventId}`;
      const history = snapshot.receipts.get(key) || [];
      const duplicate = history.find((entry) => entry.state === state);
      if (duplicate) return { receipt: duplicate, duplicate: true };
      const previous = history.at(-1)?.state || null;
      if (!RECEIPT_TRANSITIONS.get(previous)?.has(state)) {
        throw new Error(`invalid audio receipt transition ${previous || "none"} -> ${state}`);
      }
      const next = {
        schemaVersion: AUDIO_EVENT_SCHEMA_VERSION,
        eventId: safeEventId,
        consumerId: safeConsumerId,
        state,
        at,
        detail: cleanDetail,
      };
      durableAppend(journalPath, {
        schemaVersion: AUDIO_EVENT_SCHEMA_VERSION,
        kind: "receipt",
        receipt: next,
      });
      history.push(next);
      snapshot.receipts.set(key, history);
      compactIfNeeded(journalPath, snapshot, Date.parse(at));
      return { receipt: next, duplicate: false };
    });
  }

  function listPending({ consumerId, target, limit = AUDIO_REPLAY_LIMIT }) {
    const safeConsumerId = validateIdentity(consumerId, "consumerId");
    const safeTarget = targetId(target);
    const boundedLimit = Math.max(1, Math.min(AUDIO_REPLAY_LIMIT, Number(limit) || AUDIO_REPLAY_LIMIT));
    const nowMs = now().getTime();
    const snapshot = parseJournal(journalPath);
    return [...snapshot.events.values()]
      .filter((event) => event.target?.id === safeTarget && Date.parse(event.expiresAt) > nowMs)
      .filter((event) => {
        const state = snapshot.receipts
          .get(`${safeConsumerId}:${event.eventId}`)
          ?.at(-1)?.state;
        return !TERMINAL_OR_AMBIGUOUS.has(state);
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-boundedLimit);
  }

  function receiptsFor({ eventId, consumerId }) {
    const safeEventId = validateIdentity(eventId, "eventId");
    const safeConsumerId = validateIdentity(consumerId, "consumerId");
    return parseJournal(journalPath).receipts
      .get(`${safeConsumerId}:${safeEventId}`) || [];
  }

  return {
    journalPath,
    publish,
    receipt,
    listPending,
    receiptsFor,
  };
}
