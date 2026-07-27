// Agentmux Link worker: public mailbox edge (docs/link-internet-v1.md).

import { beginLinkLogin, completeLinkLogin, issueSession, requireConnector, requireSession } from "./auth.mjs";
import { ackDecision, failDecision, replyDecision, sendDecision } from "./mailbox.mjs";
import { createLinkStore } from "./store.mjs";
import { json, pkceChallenge, randomId, sha256Hex, text } from "./util.mjs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function targetsForApp(env) {
  return String(env.LINK_TARGETS || "lsrc:3|L-source 3,lsrc:10|L-source 10,windows|Windows rescue")
    .split(",").map((entry) => entry.trim()).filter(Boolean)
    .map((entry) => {
      const [id, label] = entry.split("|");
      return { id, label: label || id, kind: id === "windows" ? "windows" : "agent" };
    });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const store = createLinkStore(env.LINK_DB);
    const nowMs = Date.now();

    if (url.pathname === "/healthz") return json(null, 200, { ok: true, service: "agentmux-link" });

    // --- Auth: v1d leg -------------------------------------------------------
    if (url.pathname === "/auth/start" && request.method === "GET") {
      const challenge = String(url.searchParams.get("challenge") || "");
      if (!/^[A-Za-z0-9_-]{32,128}$/u.test(challenge)) return json(null, 400, { error: "challenge-required" });
      return Response.redirect(await beginLinkLogin({ env, challenge, client: "android" }), 302);
    }

    if (url.pathname === "/auth/callback" && request.method === "GET") {
      const completed = await completeLinkLogin({ env, url });
      if (!completed.ok) return json(null, 403, { error: completed.reason });
      const allowed = await store.identityFor(completed.principal.identityId);
      if (!allowed) return json(null, 403, { error: "identity-not-allowed" });
      const code = `xch_${randomId(24)}`;
      await store.insertExchangeCode({
        codeHash: await sha256Hex(code),
        challenge: completed.challenge,
        identityId: completed.principal.identityId,
        verifiedEmail: completed.principal.email || "",
        nowMs,
        ttlSeconds: Number(env.EXCHANGE_CODE_TTL_SECONDS) || 60,
      });
      const target = new URL("agentmux://auth");
      target.searchParams.set("code", code);
      return new Response(
        `<!doctype html><meta charset="utf-8"><title>Agentmux Link</title>`
        + `<p>Login klart. <a href="${target}">Öppna Agentmux Link</a></p>`
        + `<script>location.href=${JSON.stringify(target.toString())}</script>`,
        { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
      );
    }

    if (url.pathname === "/auth/exchange" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const code = String(body.code || "");
      const verifier = String(body.verifier || "");
      if (!code || !/^[A-Za-z0-9_-]{32,128}$/u.test(verifier)) {
        return json(null, 400, { error: "code-and-verifier-required" });
      }
      const taken = await store.takeExchangeCode(await sha256Hex(code), nowMs);
      if (!taken) return json(null, 403, { error: "code-invalid-or-used" });
      if ((await pkceChallenge(verifier)) !== taken.challenge) {
        return json(null, 403, { error: "verifier-mismatch" });
      }
      if (taken.verifiedEmail) {
        const existing = await store.bindingFor(taken.identityId);
        if (existing && existing.verifiedEmail !== taken.verifiedEmail) {
          return json(null, 409, { error: "identity-already-bound" });
        }
        if (!existing) {
          await store.bindOnce({ identityId: taken.identityId, verifiedEmail: taken.verifiedEmail, nowMs });
        }
      }
      const session = await issueSession({
        store,
        identityId: taken.identityId,
        nowMs,
        ttlSeconds: Number(env.SESSION_TTL_SECONDS) || 2_592_000,
      });
      return json(null, 200, { session, identityId: taken.identityId, targets: targetsForApp(env) });
    }

    if (url.pathname === "/auth/revoke" && request.method === "POST") {
      const header = request.headers.get("authorization") || "";
      const match = /^Bearer\s+(lnk_\S+)$/u.exec(header.trim());
      if (match) await store.revokeSession(await sha256Hex(match[1]), nowMs);
      return json(null, 200, { ok: true });
    }

    // --- App API -------------------------------------------------------------
    if (url.pathname === "/api/link/targets" && request.method === "GET") {
      const session = await requireSession({ store, request, nowMs });
      if (!session) return json(null, 401, { error: "session-required" });
      const beats = await store.heartbeatStates(90_000, nowMs);
      const online = Object.fromEntries(beats.map((row) => [row.target, row.online === 1]));
      return json(null, 200, {
        targets: targetsForApp(env).map((target) => ({ ...target, online: Boolean(online[target.id]) })),
      });
    }

    if (url.pathname === "/api/link/send" && request.method === "POST") {
      const session = await requireSession({ store, request, nowMs });
      if (!session) return json(null, 401, { error: "session-required" });
      const body = await request.json().catch(() => ({}));
      const clientMessageId = String(body.clientMessageId || "");
      const target = String(body.target || "");
      const kind = body.kind === "voice" ? "voice" : "text";
      const maxChars = Number(env.MAX_TEXT_CHARS) || 4000;
      const rawText = String(body.text ?? "").trim();
      const allowed = targetsForApp(env).some((entry) => entry.id === target);
      if (!UUID_RE.test(clientMessageId)) return json(null, 400, { error: "clientMessageId-uuid-required" });
      if (!allowed) return json(null, 403, { error: "unknown-target" });
      if (rawText.length > maxChars) return json(null, 400, { error: `text-over-${maxChars}-chars` });
      if (kind === "text" && !rawText) return json(null, 400, { error: "text-required" });
      const existing = await store.getMessage(clientMessageId);
      const decision = sendDecision({ existing, clientMessageId, target, kind, body: rawText });
      if (decision.action === "reject") return json(null, decision.status, { error: decision.reason });
      if (decision.action === "insert") {
        await store.insertMessage({ clientMessageId, target, kind, body: rawText, nowMs });
      }
      return json(null, decision.status, {
        state: "queued",
        target,
        replayed: decision.action === "replay",
      });
    }

    if (url.pathname === "/api/link/events" && request.method === "GET") {
      const session = await requireSession({ store, request, nowMs });
      if (!session) return json(null, 401, { error: "session-required" });
      const afterSeq = Number(url.searchParams.get("after") || 0) || 0;
      const events = await store.eventsAfter({ afterSeq, limit: 50 });
      const beats = await store.heartbeatStates(90_000, nowMs);
      return json(null, 200, {
        events,
        heartbeats: Object.fromEntries(beats.map((row) => [row.target, row.online === 1])),
        now: nowMs,
      });
    }

    // --- Connector API -------------------------------------------------------
    if (url.pathname === "/api/link/connector/poll" && request.method === "POST") {
      const source = url.searchParams.get("source") === "windows" ? "windows" : "wsl";
      const connector = requireConnector({ env, request, source });
      if (!connector) return json(null, 401, { error: "connector-auth-required" });
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

    if (url.pathname === "/api/link/connector/ack" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const message = await store.getMessage(String(body.clientMessageId || ""));
      const connectorId = String(body.connectorId || "");
      const source = connectorId.startsWith("windows") ? "windows" : "wsl";
      if (!requireConnector({ env, request, source })) return json(null, 401, { error: "connector-auth-required" });
      const decision = ackDecision({ message, connectorId });
      if (!decision.ok) return json(null, 409, { error: decision.reason });
      if (!decision.idempotent) await store.markDelivered({ clientMessageId: message.clientMessageId, connectorId, nowMs });
      return json(null, 200, { state: "delivered", reason: decision.reason });
    }

    if (url.pathname === "/api/link/connector/reply" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const message = await store.getMessage(String(body.clientMessageId || ""));
      const connectorId = String(body.connectorId || "");
      const source = connectorId.startsWith("windows") ? "windows" : "wsl";
      if (!requireConnector({ env, request, source })) return json(null, 401, { error: "connector-auth-required" });
      const decision = replyDecision({ message, connectorId });
      if (!decision.ok) return json(null, 409, { error: decision.reason });
      if (!decision.idempotent) {
        await store.markReplied({
          clientMessageId: message.clientMessageId,
          connectorId,
          replyBody: text(body.body, Number(env.MAX_TEXT_CHARS) || 4000),
          nowMs,
        });
      }
      return json(null, 200, { state: "replied", reason: decision.reason });
    }

    if (url.pathname === "/api/link/connector/fail" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const message = await store.getMessage(String(body.clientMessageId || ""));
      const connectorId = String(body.connectorId || "");
      const source = connectorId.startsWith("windows") ? "windows" : "wsl";
      if (!requireConnector({ env, request, source })) return json(null, 401, { error: "connector-auth-required" });
      const decision = failDecision({ message, connectorId });
      if (!decision.ok) return json(null, 409, { error: decision.reason });
      if (!decision.idempotent) {
        await store.markFailed({ clientMessageId: message.clientMessageId, connectorId, error: body.error, nowMs });
      }
      return json(null, 200, { state: "failed", reason: decision.reason });
    }

    return json(null, 404, { error: "route-not-found" });
  },
};
