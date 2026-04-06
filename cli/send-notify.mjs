// Notification delivery via OpenClaw gateway WebSocket.
// Replaces claw-send.cjs + claw notify/msg shell commands.

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
    // Try exact match, then case-insensitive
    if (cache[channelName]) return cache[channelName];
    const lower = channelName.toLowerCase();
    for (const [k, v] of Object.entries(cache)) {
      if (k.toLowerCase() === lower) return v;
    }
  } catch {}
  return null;
}

/** Send a message via OpenClaw gateway WebSocket. */
async function gatewaySend(method, params) {
  // Dynamic import to avoid requiring ws at module load
  const { WebSocket } = await import("ws");
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("gateway timeout")); }, 5000);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: { ...params, token: GATEWAY_TOKEN },
      }));
    });

    ws.on("message", (data) => {
      clearTimeout(timeout);
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } catch (e) { reject(e); }
      ws.close();
    });

    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

/** Send a message to a Discord channel by name. */
export async function sendToChannel(channelName, message) {
  const channelId = resolveChannelId(channelName);
  if (!channelId) throw new Error(`Channel '${channelName}' not found in cache`);
  return gatewaySend("send", { target: channelId, message });
}

/** Send a message to an OpenClaw session. */
export async function sendToSession(sessionKey, message) {
  return gatewaySend("chat.inject", { session: sessionKey, content: message, role: "assistant" });
}
