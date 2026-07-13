// Notification delivery via OpenClaw gateway WebSocket.
// Replaces claw-send.cjs + claw notify/msg shell commands.
//
// Protocol: see memory/references/gateway-ws-protocol.md. First frame must
// be a `connect` req with auth token; after hello-ok, subsequent methods
// use `{type: "req", id, method, params}` format.

import { createHash, randomUUID } from "crypto";
import {
  mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { splitMessage } from "../lib.mjs";

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || (() => {
  try {
    const config = JSON.parse(readFileSync(join(process.env.HOME, ".openclaw/openclaw.json"), "utf-8"));
    return config.gateway?.auth?.token || "";
  } catch { return ""; }
})();

const CHANNEL_CACHE = join(process.env.HOME, ".openclaw/.channel-cache.json");
const NOTIFY_USER_STATE = join(process.env.HOME, ".openclaw/.notifyuser-state.json");
const NOTIFY_USER_STATE_LOCK_DIR = `${NOTIFY_USER_STATE}.lock.d`;
const DEFAULT_NOTIFY_USER_DEDUPE_MS = 10 * 60 * 1000;
const DISCORD_POST_TIMEOUT_MS = Number.parseInt(process.env.AMUX_DISCORD_POST_TIMEOUT_MS || "8000", 10);
const NOTIFY_STATE_LOCK_TIMEOUT_MS = 10_000;
const NOTIFY_STATE_STALE_LOCK_MS = 30_000;
const NOTIFY_STATE_CLAIM_SETTLE_MS = 25;

/** Resolve channel name to Discord channel ID. */
export function resolveChannelId(channelName) {
  try {
    const cache = JSON.parse(readFileSync(CHANNEL_CACHE, "utf-8"));
    if (cache[channelName]) return cache[channelName];
    const lower = channelName.toLowerCase();
    for (const [k, v] of Object.entries(cache)) {
      if (k.toLowerCase() === lower) return v;
    }
  } catch {}
  return null;
}

/**
 * Send a request via OpenClaw gateway WebSocket, completing the connect
 * handshake first. The gateway may emit an info-only `connect.challenge`
 * event — ignore it until we see the `res` frame for our connect id.
 */
function mkIdempotencyKey() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

async function gatewaySend(method, params) {
  const { WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL, {
      headers: { origin: "http://127.0.0.1:18789" },
    });
    const timeout = setTimeout(() => { ws.close(); reject(new Error("gateway timeout")); }, 8000);

    ws.on("open", () => {
      // connect handshake — mirrors claw-send.cjs reference client
      ws.send(JSON.stringify({
        type: "req",
        id: "1",
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: { id: "openclaw-control-ui", version: "1.0.0", platform: "linux", mode: "backend" },
          scopes: ["operator.read", "operator.write"],
          auth: { token: GATEWAY_TOKEN },
        },
      }));
    });

    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === "res" && msg.id === "1") {
        if (!msg.ok) {
          clearTimeout(timeout);
          reject(new Error(`gateway connect failed: ${JSON.stringify(msg.payload || msg)}`));
          ws.close();
          return;
        }
        // Actual method call with idempotencyKey
        ws.send(JSON.stringify({
          type: "req",
          id: "2",
          method,
          params: { ...params, idempotencyKey: mkIdempotencyKey() },
        }));
      } else if (msg.type === "res" && msg.id === "2") {
        clearTimeout(timeout);
        if (!msg.ok) reject(new Error(`gateway ${method} failed: ${JSON.stringify(msg.payload || msg)}`));
        else resolve(msg.payload);
        ws.close();
      }
      // ignore info-only events (connect.challenge, etc)
    });

    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

/**
 * Resolve the agentmux bot's Discord token. Preferred over gateway because
 * the gateway's bot may not be invited to all the channels agentmux manages,
 * while agentmux's own bot is (that's how the bridge talks to them).
 */
function getDiscordBotToken() {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN;
  // Fall back to agentmux/.env
  try {
    const __dir = new URL("..", import.meta.url).pathname;
    const envText = readFileSync(join(__dir, ".env"), "utf-8");
    const m = envText.match(/^DISCORD_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  } catch {}
  return "";
}

export function discordMessagePayload(content, nonce = null) {
  return { content: String(content).slice(0, 2000),
    ...(nonce ? { nonce, enforce_nonce: true } : {}) };
}

/** Post to a Discord channel directly via REST API using agentmux's bot token. */
async function discordPost(channelId, content, nonce = null) {
  const token = getDiscordBotToken();
  if (!token) throw new Error("DISCORD_TOKEN not found — cannot mirror");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_POST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(discordMessagePayload(content, nonce)),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`discord post ${res.status}: ${body}`);
  }
  return res.json();
}

/** Open or create a DM channel with a Discord user. */
async function discordCreateDm(userId) {
  const token = getDiscordBotToken();
  if (!token) throw new Error("DISCORD_TOKEN not found — cannot DM user");
  const res = await fetch("https://discord.com/api/v10/users/@me/channels", {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ recipient_id: String(userId) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`discord dm-open ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Post a file (e.g. an mp3 from edge-tts) to a Discord channel.
 * Uses multipart/form-data — JSON-only `discordPost` can't carry binaries.
 * `text` is an optional message body that lands alongside the attachment.
 */
async function discordPostFile(channelId, filePath, text = "") {
  const token = getDiscordBotToken();
  if (!token) throw new Error("DISCORD_TOKEN not found — cannot post file");
  const fileBuffer = readFileSync(filePath);
  const fileName = filePath.split("/").pop() || "audio.mp3";

  const formData = new FormData();
  formData.append("payload_json", JSON.stringify({ content: text.slice(0, 2000) }));
  formData.append("files[0]", new Blob([fileBuffer]), fileName);

  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
    body: formData,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`discord file-post ${res.status}: ${body}`);
  }
  return res.json();
}

/** PATCH a Discord channel (used for topic updates). */
async function discordPatch(channelId, patch) {
  const token = getDiscordBotToken();
  if (!token) throw new Error("DISCORD_TOKEN not found — cannot patch channel");
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`discord patch ${res.status}: ${body}`);
  }
  return res.json();
}

/**
 * Set a Discord channel topic, throttled per-channel to avoid hitting
 * Discord's 2-edits-per-10-min rate limit. State lives in a small JSON
 * file shared across processes (every `amux` invocation is a fresh node
 * process, so in-memory throttling won't work).
 *
 * Returns { updated: bool, reason }. Failures are non-fatal: the caller
 * already wrote the source-of-truth (tmux) and the message mirror.
 */
const TOPIC_STATE = join(process.env.HOME, ".openclaw/.topic-throttle.json");
// Discord caps channel topic edits at 2/10min/channel. Throttle window
// must match or exceed that ceiling or we burn the budget and hit 429.
const TOPIC_MIN_INTERVAL_MS = 600_000;
const TOPIC_MAX_LEN = 1024;

export async function setChannelTopicThrottled(channelId, topic, minIntervalMs = TOPIC_MIN_INTERVAL_MS) {
  if (!channelId || !topic) return { updated: false, reason: "missing-input" };

  const trimmed = topic.length > TOPIC_MAX_LEN ? topic.slice(0, TOPIC_MAX_LEN - 1) + "…" : topic;

  let state = {};
  try { state = JSON.parse(readFileSync(TOPIC_STATE, "utf-8")) || {}; } catch {}

  const now = Date.now();
  const entry = state[channelId] || {};
  const since = now - (entry.ts || 0);
  if (since < minIntervalMs && entry.topic === trimmed) {
    return { updated: false, reason: "unchanged-recent" };
  }
  if (since < minIntervalMs) {
    // Throttle window not yet open. Skip honestly; no background flusher
    // exists for deferred topic writes.
    return { updated: false, reason: "throttled" };
  }

  try {
    await discordPatch(channelId, { topic: trimmed });
    state[channelId] = { ts: now, topic: trimmed };
    try { writeFileSync(TOPIC_STATE, JSON.stringify(state)); } catch {}
    return { updated: true };
  } catch (err) {
    return { updated: false, reason: `error: ${err.message}` };
  }
}

/** Send a message to a Discord channel by name. */
export async function sendToChannel(channelName, message) {
  const channelId = resolveChannelId(channelName);
  if (!channelId) throw new Error(`Channel '${channelName}' not found in cache`);
  return sendToChannelId(channelId, message);
}

/** Send a message directly to a Discord channel by raw channel ID. */
export async function sendToChannelId(channelId, message) {
  const chunks = splitMessage(String(message || ""));
  const results = [];
  for (const chunk of chunks) results.push(await discordPost(channelId, chunk));
  return results;
}

export function resolveNotifyUserId(explicitUserId) {
  if (explicitUserId) return String(explicitUserId);
  if (process.env.AMUX_NOTIFY_USER_ID) return process.env.AMUX_NOTIFY_USER_ID;
  if (process.env.AMUX_NOTIFY_USER_DISCORD_ID) return process.env.AMUX_NOTIFY_USER_DISCORD_ID;

  try {
    const doc = JSON.parse(readFileSync(join(process.env.HOME, ".openclaw/credentials/discord-allowFrom.json"), "utf-8"));
    const allowFrom = doc.allowFrom;
    if (typeof allowFrom === "string") return allowFrom;
    if (Array.isArray(allowFrom) && allowFrom.length === 1) return String(allowFrom[0]);
  } catch {}
  return "";
}

export function formatUserNotification(message, { level = "info", title = "" } = {}) {
  const clean = String(message || "").replace(/\s+/g, " ").trim();
  if (!clean) throw new Error("notifyuser message is empty");
  const normalized = String(level || "info").toLowerCase();
  const icon = {
    info: "🔔",
    done: "✅",
    warn: "⚠️",
    warning: "⚠️",
    error: "🚨",
    urgent: "🚨",
  }[normalized] || "🔔";
  const label = normalized === "warning" ? "warn" : normalized;
  const heading = title ? `${icon} **${title}** (${label})` : `${icon} **amux** (${label})`;
  return `${heading}\n${clean}`.slice(0, 1900);
}

function notifyKey(content, userId, channelName, idempotencyKey = null) {
  const identity = idempotencyKey == null ? content : `idempotency:${idempotencyKey}`;
  return createHash("sha256")
    .update(`${userId || ""}\0${channelName || ""}\0${identity}`).digest("hex");
}

export function notificationNonce(idempotencyKey) {
  if (idempotencyKey == null) return null;
  if (typeof idempotencyKey !== "string" || Buffer.byteLength(idempotencyKey, "utf8") > 256
      || !/^[a-zA-Z0-9:._/-]+$/u.test(idempotencyKey)) {
    throw new Error("idempotencyKey must be 1-256 safe identity characters");
  }
  return createHash("sha256").update(`notifyuser\0${idempotencyKey}`).digest("hex").slice(0, 25);
}

function readNotifyState() {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(NOTIFY_USER_STATE, "utf-8"));
  } catch (err) {
    if (err?.code === "ENOENT") return {};
    throw new Error(`notify receipt state is unreadable: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("notify receipt state must be a JSON object");
  }
  return parsed;
}

function writeNotifyStateAtomic(state) {
  const stateDir = dirname(NOTIFY_USER_STATE);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tempPath = join(stateDir,
    `.notifyuser-state.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  try {
    writeFileSync(tempPath, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    renameSync(tempPath, NOTIFY_USER_STATE);
  } finally {
    try { unlinkSync(tempPath); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function withNotifyStateLock(action) {
  mkdirSync(dirname(NOTIFY_USER_STATE), { recursive: true, mode: 0o700 });
  mkdirSync(NOTIFY_USER_STATE_LOCK_DIR, { recursive: true, mode: 0o700 });
  const claimName = `${Date.now()}-${process.pid}-${randomUUID()}.claim`;
  const claimPath = join(NOTIFY_USER_STATE_LOCK_DIR, claimName);
  writeFileSync(claimPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
  const deadline = Date.now() + NOTIFY_STATE_LOCK_TIMEOUT_MS;

  try {
    // A short settle window means every contender that could predate this
    // critical section is visible before deterministic election. Later claims
    // always see this live claim and wait. Unique filenames make stale cleanup
    // ABA-safe: a recoverer can never unlink a replacement owner's claim.
    await delay(NOTIFY_STATE_CLAIM_SETTLE_MS);
    while (true) {
      const now = Date.now();
      const contenders = [];
      for (const name of readdirSync(NOTIFY_USER_STATE_LOCK_DIR)) {
        if (!name.endsWith(".claim")) continue;
        const path = join(NOTIFY_USER_STATE_LOCK_DIR, name);
        let stat;
        try {
          stat = statSync(path, { bigint: true });
        } catch (err) {
          if (err?.code === "ENOENT") continue;
          throw err;
        }
        const ageMs = now - Number(stat.mtimeNs / 1_000_000n);
        if (name !== claimName && ageMs > NOTIFY_STATE_STALE_LOCK_MS) {
          try { unlinkSync(path); } catch (err) { if (err?.code !== "ENOENT") throw err; }
          continue;
        }
        contenders.push({ name, mtimeNs: stat.mtimeNs });
      }
      contenders.sort((left, right) => left.mtimeNs < right.mtimeNs ? -1
        : left.mtimeNs > right.mtimeNs ? 1 : left.name.localeCompare(right.name));
      if (contenders[0]?.name === claimName) break;
      if (Date.now() >= deadline) throw new Error("timed out acquiring notify receipt state lock");
      await delay(5 + Math.floor(Math.random() * 11));
    }
    return await action();
  } finally {
    try { unlinkSync(claimPath); } catch (err) { if (err?.code !== "ENOENT") throw err; }
  }
}

function isDuplicateNotification(key, dedupeMs) {
  if (!dedupeMs) return false;
  const state = readNotifyState();
  if (!Object.prototype.hasOwnProperty.call(state, key)) return false;
  const last = state[key];
  if (!Number.isFinite(last)) return false;
  return Date.now() - last < dedupeMs;
}

async function rememberNotification(key) {
  await withNotifyStateLock(() => {
    const state = readNotifyState();
    state[key] = Date.now();
    writeNotifyStateAtomic(state);
  });
}

/**
 * Send a high-signal notification to the human. Prefers Discord DM for mobile
 * push; falls back to the configured notify channel with a mention.
 */
export async function notifyUser(message, opts = {}) {
  const userId = resolveNotifyUserId(opts.userId || opts.user);
  const channelName = opts.channel || process.env.AMUX_NOTIFY_CHANNEL || "notify";
  const content = formatUserNotification(message, opts);
  const nonce = notificationNonce(opts.idempotencyKey);
  const key = notifyKey(content, userId, channelName, opts.idempotencyKey);
  const dedupeMs = nonce ? Number.POSITIVE_INFINITY
    : opts.force ? 0 : (opts.dedupeMs ?? DEFAULT_NOTIFY_USER_DEDUPE_MS);
  if (isDuplicateNotification(key, dedupeMs)) {
    return { sent: false, deduped: true, target: "dedupe" };
  }

  let dmError = null;
  if (userId) {
    try {
      const dm = await discordCreateDm(userId);
      if (!dm?.id) throw new Error("Discord DM response missing channel id");
      await discordPost(dm.id, content, nonce);
    } catch (err) {
      dmError = err;
    }
    if (!dmError) {
      // Receipt failures must remain visible, but must not turn a successful DM
      // into a second fallback-channel post.
      await rememberNotification(key);
      return { sent: true, target: "dm", userId };
    }
  }

  const channelId = resolveChannelId(channelName);
  if (!channelId) {
    const suffix = dmError ? `; DM failed: ${dmError.message}` : "";
    throw new Error(`notify channel '${channelName}' not found${suffix}`);
  }
  const fallback = userId ? `<@${userId}>\n${content}` : content;
  await discordPost(channelId, fallback, nonce);
  await rememberNotification(key);
  return { sent: true, target: channelName, channelId, fallback: !!dmError, dmError: dmError?.message };
}

/** Send a file (e.g. tts mp3) to a Discord channel by raw ID, with optional text body. */
export async function sendFileToChannelId(channelId, filePath, text = "") {
  return discordPostFile(channelId, filePath, text);
}

/** Send a message to an OpenClaw session. */
export async function sendToSession(sessionKey, message) {
  return gatewaySend("chat.inject", { sessionKey, message, label: "agentmux" });
}
