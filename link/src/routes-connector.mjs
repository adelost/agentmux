// Connector routes: poll with leases, ack, reply, fail, voice download.

import { requireConnector } from "./auth.mjs";
import { ackDecision, failDecision, replyDecision } from "./mailbox.mjs";
import { requestRateLimited } from "./config.mjs";
import { json, text } from "./util.mjs";

const connectorContext = ({ env, request, url }) => {
  const source = url.searchParams.get("source") === "windows" ? "windows" : "wsl";
  return { source, connector: requireConnector({ env, request, source }) };
};

/** WHAT: Routes one connector API request. WHY: Keeps connector claim and completion behind one ownership-checked handler. */
export async function handleConnectorRoutes({ request, env, store, url, nowMs }) {
  if (url.pathname === "/api/link/connector/poll" && request.method === "POST") {
    const { source, connector } = connectorContext({ env, request, url });
    if (!connector) return json(null, 401, { error: "connector-auth-required" });
    if (await requestRateLimited({
      store,
      request,
      subject: `connector:${connector.connectorId}`,
      scope: "connector-poll",
      bucket: Math.floor(nowMs / 60_000),
      max: Number(env.RATE_POLL_PER_MINUTE) || 120,
    })) {
      return json(null, 429, { error: "rate-limited" });
    }
    await store.reclaimExpiredLeases(nowMs);
    await store.reclaimStaleDelivered(nowMs - (Number(env.REPLY_TIMEOUT_SECONDS) || 600) * 1000);
    const messages = await store.claimQueued({
      connectorId: connector.connectorId,
      targets: connector.targets,
      leaseMs: (Number(env.CONNECTOR_LEASE_SECONDS) || 60) * 1000,
      nowMs,
    });
    for (const target of connector.targets) {
      await store.heartbeat({ connectorId: connector.connectorId, target, source, nowMs });
    }
    return json(null, 200, { messages });
  }

  if (url.pathname.startsWith("/api/link/voice/") && request.method === "GET") {
    const { connector } = connectorContext({ env, request, url });
    if (!connector) return json(null, 401, { error: "connector-auth-required" });
    const voiceRef = url.pathname.slice("/api/link/voice/".length);
    if (!/^voice\/[\w-]{8,80}\.m4a$/u.test(voiceRef)) return json(null, 400, { error: "voiceRef-invalid" });
    const message = await store.getMessageForVoice(voiceRef);
    if (!message) return json(null, 404, { error: "voice-message-not-found" });
    if (!connector.targets.includes(message.target)) {
      return json(null, 403, { error: "connector-scope-required" });
    }
    const object = await env.LINK_VOICE.get(voiceRef);
    if (!object) return json(null, 404, { error: "voice-not-found" });
    return new Response(object.body, { headers: { "content-type": "audio/mp4", "cache-control": "no-store" } });
  }

  for (const [path, decide, apply] of [
    ["/api/link/connector/ack", ackDecision, ({ message, connectorId }) =>
      store.markDelivered({ clientMessageId: message.clientMessageId, connectorId, nowMs })],
    ["/api/link/connector/reply", replyDecision, async ({ message, connectorId, body }) => {
      await store.markReplied({
        clientMessageId: message.clientMessageId,
        connectorId,
        replyBody: text(body.body, Number(env.MAX_TEXT_CHARS) || 4000),
        nowMs,
      });
      if (message.voiceRef) await env.LINK_VOICE.delete(message.voiceRef).catch(() => {});
    }],
    ["/api/link/connector/fail", failDecision, async ({ message, connectorId, body }) => {
      await store.markFailed({ clientMessageId: message.clientMessageId, connectorId, error: body.error, nowMs });
      if (message.voiceRef) await env.LINK_VOICE.delete(message.voiceRef).catch(() => {});
    }],
  ]) {
    if (url.pathname === path && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const message = await store.getMessage(String(body.clientMessageId || ""));
      const requestedConnectorId = String(body.connectorId || "");
      const source = requestedConnectorId.startsWith("windows") ? "windows" : "wsl";
      const connector = requireConnector({ env, request, source });
      if (!connector) return json(null, 401, { error: "connector-auth-required" });
      if (requestedConnectorId !== connector.connectorId ||
          (message && !connector.targets.includes(message.target))) {
        return json(null, 403, { error: "connector-scope-required" });
      }
      const decision = decide({ message, connectorId: connector.connectorId });
      if (!decision.ok) return json(null, 409, { error: decision.reason });
      if (!decision.idempotent) await apply({
        message,
        connectorId: connector.connectorId,
        body,
      });
      const state = path.endsWith("/ack") ? "delivered" : path.endsWith("/reply") ? "replied" : "failed";
      return json(null, 200, { state, reason: decision.reason });
    }
  }

  return null;
}
