// Notification delivery via OpenClaw gateway WebSocket.
// Replaces claw-send.cjs + claw notify/msg shell commands.
//
// Protocol: see memory/references/gateway-ws-protocol.md. First frame must
// be a `connect` req with auth token; after hello-ok, subsequent methods
// use `{type: "req", id, method, params}` format.

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || (() => {
  try {
    const config = JSON.parse(readFileSync(join(process.env.HOME, ".openclaw/openclaw.json"), "utf-8"));
    return config.gateway?.auth?.token || "";
  } catch { return ""; }
})();

const CHANNEL_CACHE = join(process.env.HOME, ".openclaw/.channel-cache.json");

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
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content: content.slice(0, 2000) }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`discord post ${res.status}: ${body}`);
  }
  return res.json();
}

/** Send a message to a Discord channel by name. */
export async function sendToChannel(channelName, message) {
  const channelId = resolveChannelId(channelName);
  if (!channelId) throw new Error(`Channel '${channelName}' not found in cache`);
  return discordPost(channelId, message);
}

/** Send a message directly to a Discord channel by raw channel ID. */
export async function sendToChannelId(channelId, message) {
  return discordPost(channelId, message);
}

/** Send a message to an OpenClaw session. */
export async function sendToSession(sessionKey, message) {
  return gatewaySend("chat.inject", { sessionKey, message, label: "agentmux" });
}
