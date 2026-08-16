// Durable intake journal for human Discord messages.

import { createHash, randomUUID } from "crypto";
import {
  chmodSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync,
  renameSync, unlinkSync, writeFileSync,
} from "fs";
import { homedir } from "os";
import { extname, join } from "path";
import { downloadDiscordAttachment } from "./discord-attachment-download.mjs";

const STORE_VERSION = 1;
const RETRY_MS = 30_000;

/** WHAT: Resolves the private Discord intake directory. WHY: Keeps inbound truth outside replaceable packages and temporary process state. */
export function defaultDiscordInboundDir() {
  return process.env.AMUX_DISCORD_INBOUND_DIR
    || join(homedir(), ".agentmux", "discord-inbound");
}

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch {}
}

function safeSegment(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 160);
}

function atomicJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

function atomicBuffer(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
}

function parse(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function attachmentRecord(att, previous = null) {
  return {
    id: String(att?.id || previous?.id || "attachment"),
    name: String(att?.name || previous?.name || "attachment.bin"),
    url: att?.url || previous?.url || null,
    proxyUrl: att?.proxyUrl || previous?.proxyUrl || null,
    contentType: att?.contentType || previous?.contentType || null,
    durablePath: previous?.durablePath || null,
    sha256: previous?.sha256 || null,
    downloadedAt: previous?.downloadedAt || null,
    bytes: previous?.bytes || null,
    transcript: previous?.transcript || null,
    transcribedAt: previous?.transcribedAt || null,
  };
}

/**
 * WHAT: Stores Discord observations, attachment bytes, effects, and channel cursors.
 * WHY: A bridge crash must leave enough truth to resume without Gateway replay or duplicate sends.
 */
export function createDiscordInboundStore({
  rootDir = defaultDiscordInboundDir(),
  downloadBuffer,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  ensurePrivateDir(rootDir);
  const messagesRoot = join(rootDir, "messages");
  const assetsRoot = join(rootDir, "assets");
  const cursorsPath = join(rootDir, "cursors.json");
  ensurePrivateDir(messagesRoot);
  ensurePrivateDir(assetsRoot);

  const channelDir = (channelId) => join(messagesRoot, safeSegment(channelId));
  const pathFor = (channelId, messageId) =>
    join(channelDir(channelId), `${safeSegment(messageId)}.json`);

  function read(channelId, messageId) {
    const path = pathFor(channelId, messageId);
    const record = parse(path);
    return record ? { ...record, path } : null;
  }

  function update(record, patch) {
    const current = read(record.channelId, record.messageId);
    if (!current) throw new Error(`Discord inbound record disappeared: ${record.identity}`);
    const next = {
      ...current,
      ...patch,
      target: patch.target ? { ...current.target, ...patch.target } : current.target,
      effects: patch.effects ? { ...(current.effects || {}), ...patch.effects } : (current.effects || {}),
    };
    delete next.path;
    atomicJson(current.path, next);
    return { ...next, path: current.path };
  }

  /** WHAT: Persists one normalized human message before any network or agent work. WHY: Later attachment and delivery failures must be recoverable by stable Discord identity. */
  function observe(msg, target) {
    if (!msg?.channelId || !msg?.id) throw new Error("Discord inbound identity is incomplete");
    if (!target?.agentName || !Number.isInteger(Number(target.pane))) {
      throw new Error(`Discord inbound target is unresolved for ${msg.channelId}:${msg.id}`);
    }
    const identity = `discord:${msg.channelId}:${msg.id}`;
    const dir = channelDir(msg.channelId);
    ensurePrivateDir(dir);
    const path = pathFor(msg.channelId, msg.id);
    const current = read(msg.channelId, msg.id);
    if (current) {
      const prior = new Map((current.attachments || []).map((att) => [att.id, att]));
      return update(current, {
        text: String(msg.text || current.text || ""),
        authorId: String(msg.authorId || current.authorId || "unknown"),
        lastObservedAt: now(),
        attachments: (msg.attachments || current.attachments || [])
          .map((att) => attachmentRecord(att, prior.get(String(att.id)))),
      });
    }

    const record = {
      version: STORE_VERSION,
      identity,
      channelId: String(msg.channelId),
      messageId: String(msg.id),
      authorId: String(msg.authorId || "unknown"),
      text: String(msg.text || ""),
      target: {
        agentName: String(target.agentName),
        pane: Number(target.pane),
        dir: target.dir ? String(target.dir) : null,
      },
      createdTimestamp: Number(msg.createdTimestamp) || now(),
      observedAt: now(),
      lastObservedAt: now(),
      status: "observed",
      attempts: 0,
      nextAttemptAt: now(),
      lastError: null,
      completedAt: null,
      effects: {},
      attachments: (msg.attachments || []).map((att) => attachmentRecord(att)),
    };
    const tmp = `${path}.new-${process.pid}-${randomUUID()}`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    try { linkSync(tmp, path); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
    return read(msg.channelId, msg.id);
  }

  /** WHAT: Copies every attachment into the private journal. WHY: Discord signed URLs may expire before transcription or pane delivery retries. */
  async function prepareAttachments(record) {
    let current = read(record.channelId, record.messageId) || record;
    for (const attachment of current.attachments || []) {
      if (attachment.durablePath && existsSync(attachment.durablePath)) continue;
      if (typeof downloadBuffer !== "function") {
        throw new Error(`Discord attachment downloader is unavailable for ${current.identity}`);
      }
      const bytes = await downloadDiscordAttachment(attachment, { downloadBuffer, sleep });
      const dir = join(assetsRoot, safeSegment(current.channelId), safeSegment(current.messageId));
      ensurePrivateDir(dir);
      const extension = extname(attachment.name || "").slice(0, 16) || ".bin";
      const durablePath = join(dir, `${safeSegment(attachment.id)}${extension}`);
      atomicBuffer(durablePath, bytes);
      const nextAttachment = {
        ...attachment,
        durablePath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        downloadedAt: now(),
        bytes: bytes.length,
      };
      current = update(current, {
        attachments: current.attachments.map((candidate) =>
          candidate.id === attachment.id ? nextAttachment : candidate),
      });
    }
    return update(current, {
      status: "assets_ready",
      attachmentsReadyAt: now(),
      nextAttemptAt: now(),
      lastError: null,
    });
  }

  /** WHAT: Reads the exact journaled transcript for one attachment. WHY: A lost Discord acknowledgement must not rerun STT or diverge from the pane prompt. */
  function transcriptFor(record, attachmentId) {
    const current = read(record.channelId, record.messageId) || record;
    const attachment = (current.attachments || [])
      .find((candidate) => String(candidate.id) === String(attachmentId));
    return typeof attachment?.transcript === "string" ? attachment.transcript : null;
  }

  /** WHAT: Journals one completed STT result before any outbound effect. WHY: Discord reply and pane delivery must retry from identical content. */
  function saveTranscript(record, attachmentId, transcript) {
    const current = read(record.channelId, record.messageId) || record;
    const id = String(attachmentId);
    const text = String(transcript || "");
    const attachments = (current.attachments || []).map((attachment) =>
      String(attachment.id) === id
        ? { ...attachment, transcript: text, transcribedAt: now() }
        : attachment);
    if (!attachments.some((attachment) => String(attachment.id) === id)) {
      throw new Error(`Discord transcript attachment disappeared: ${current.identity}:${id}`);
    }
    update(current, { attachments });
    return text;
  }

  /** WHAT: Begins or resumes one transport-idempotent outbound effect. WHY: Keeps a lost acknowledgement retryable while a completed effect stays suppressed. */
  function beginEffect(record, effect) {
    const current = read(record.channelId, record.messageId) || record;
    if (current.effects?.[effect]?.status === "sent") return false;
    update(current, { effects: { [effect]: {
      status: "sending",
      firstAttemptAt: current.effects?.[effect]?.firstAttemptAt || now(),
      lastAttemptAt: now(),
      attempts: Number(current.effects?.[effect]?.attempts || 0) + 1,
    } } });
    return true;
  }

  /** WHAT: Records one completed outbound side effect. WHY: Replays need durable proof that no second transcript should be posted. */
  function completeEffect(record, effect) {
    const current = read(record.channelId, record.messageId) || record;
    update(current, { effects: { [effect]: { ...(current.effects?.[effect] || {}), status: "sent", sentAt: now() } } });
  }

  /** WHAT: Marks one inbound record complete after its handler accepts it. WHY: Gateway and REST duplicates must become no-ops across restarts. */
  function complete(record, outcome = null) {
    return update(record, {
      status: "completed",
      completedAt: now(),
      nextAttemptAt: null,
      lastError: null,
      outcome: outcome || null,
    });
  }

  /** WHAT: Retains one failed inbound record for bounded retry. WHY: Attachment, STT, or queue failures must not advance to false completion. */
  function fail(record, error) {
    const current = read(record.channelId, record.messageId) || record;
    return update(current, {
      attempts: Number(current.attempts || 0) + 1,
      nextAttemptAt: now() + RETRY_MS,
      lastError: String(error?.message || error).slice(0, 1_000),
    });
  }

  function list(channelId) {
    const dir = channelDir(channelId);
    try {
      return readdirSync(dir).filter((name) => name.endsWith(".json"))
        .flatMap((name) => {
          const record = parse(join(dir, name));
          return record ? [{ ...record, path: join(dir, name) }] : [];
        })
        .sort((a, b) => Number(a.createdTimestamp) - Number(b.createdTimestamp)
          || String(a.messageId).localeCompare(String(b.messageId)));
    } catch { return []; }
  }

  /** WHAT: Lists channels retained by the journal or cursor index. WHY: Keeps staged work reachable after its live config mapping disappears. */
  function channelIds() {
    let messageChannels = [];
    try { messageChannels = readdirSync(messagesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch {}
    return [...new Set([...messageChannels, ...Object.keys(cursors())])];
  }

  /** WHAT: Lists records whose handler has not completed. WHY: Startup catch-up must resume staged work even after its channel cursor advanced. */
  function pending(channelId) {
    return list(channelId).filter((record) => record.status !== "completed"
      && Number(record.nextAttemptAt || 0) <= now());
  }

  function cursors() {
    return parse(cursorsPath, {}) || {};
  }

  /** WHAT: Reads one durable channel cursor. WHY: Gateway reconnects need a stable REST starting point outside temporary app state. */
  function cursor(channelId) {
    return cursors()[channelId] || null;
  }

  /** WHAT: Advances one channel cursor after observations are durable. WHY: Re-fetch may duplicate records but a crash may never skip an unrecorded human message. */
  function advanceCursor(channelId, messageId) {
    if (!messageId) return cursor(channelId);
    const all = cursors();
    all[channelId] = String(messageId);
    atomicJson(cursorsPath, all);
    return all[channelId];
  }

  return {
    rootDir, observe, read, update, prepareAttachments, transcriptFor, saveTranscript,
    beginEffect, completeEffect,
    complete, fail, list, pending, channelIds, cursor, advanceCursor,
  };
}
