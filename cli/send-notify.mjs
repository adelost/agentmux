// Notification delivery via OpenClaw gateway WebSocket.
// Replaces claw-send.cjs + claw notify/msg shell commands.
//
// Protocol: see memory/references/gateway-ws-protocol.md. First frame must
// be a `connect` req with auth token; after hello-ok, subsequent methods
// use `{type: "req", id, method, params}` format.

import { createHash } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
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
const DEFAULT_NOTIFY_USER_DEDUPE_MS = 10 * 60 * 1000;
const DISCORD_POST_TIMEOUT_MS = Number.parseInt(process.env.AMUX_DISCORD_POST_TIMEOUT_MS || "8000", 10);

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

/** Post to a Discord channel directly via REST API using agentmux's bot token. */
async function discordPost(channelId, content) {
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
      body: JSON.stringify({ content: content.slice(0, 2000) }),
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

function notifyKey(content, userId, channelName) {
  return createHash("sha256").update(`${userId || ""}\0${channelName || ""}\0${content}`).digest("hex");
}

function readNotifyState() {
  try { return JSON.parse(readFileSync(NOTIFY_USER_STATE, "utf-8")) || {}; } catch { return {}; }
}

function writeNotifyState(state) {
  try { writeFileSync(NOTIFY_USER_STATE, JSON.stringify(state)); } catch {}
}

function isDuplicateNotification(key, dedupeMs) {
  if (!dedupeMs) return false;
  const state = readNotifyState();
  const last = state[key] || 0;
  return Date.now() - last < dedupeMs;
}

function rememberNotification(key) {
  const state = readNotifyState();
  state[key] = Date.now();
  writeNotifyState(state);
}

/**
 * Send a high-signal notification to the human. Prefers Discord DM for mobile
 * push; falls back to the configured notify channel with a mention.
 */
export async function notifyUser(message, opts = {}) {
  const userId = resolveNotifyUserId(opts.userId || opts.user);
  const channelName = opts.channel || process.env.AMUX_NOTIFY_CHANNEL || "notify";
  const content = formatUserNotification(message, opts);
  const key = notifyKey(content, userId, channelName);
  const dedupeMs = opts.force ? 0 : (opts.dedupeMs ?? DEFAULT_NOTIFY_USER_DEDUPE_MS);
  if (isDuplicateNotification(key, dedupeMs)) {
    return { sent: false, deduped: true, target: "dedupe" };
  }

  let dmError = null;
  if (userId) {
    try {
      const dm = await discordCreateDm(userId);
      if (!dm?.id) throw new Error("Discord DM response missing channel id");
      await discordPost(dm.id, content);
      rememberNotification(key);
      return { sent: true, target: "dm", userId };
    } catch (err) {
      dmError = err;
    }
  }

  const channelId = resolveChannelId(channelName);
  if (!channelId) {
    const suffix = dmError ? `; DM failed: ${dmError.message}` : "";
    throw new Error(`notify channel '${channelName}' not found${suffix}`);
  }
  const fallback = userId ? `<@${userId}>\n${content}` : content;
  await discordPost(channelId, fallback);
  rememberNotification(key);
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
