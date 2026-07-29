// App-facing routes: targets, idempotent send, identity-scoped events, voice.

import { requireSession } from "./auth.mjs";
import { sendDecision } from "./mailbox.mjs";
import { targetsForApp, privateDiscoveryUrlsForApp, requestRateLimited, UUID_RE } from "./config.mjs";
import { json } from "./util.mjs";

async function deleteUnusedVoice(env, voiceRef, existing) {
  if (!voiceRef || existing?.voiceRef === voiceRef) return;
  await env.LINK_VOICE.delete(voiceRef).catch(() => {});
}

/** WHAT: Routes one app API request. WHY: Keeps session-facing endpoints behind one identity-scoped handler. */
export async function handleAppRoutes({ request, env, store, url, nowMs }) {
  if (url.pathname === "/api/link/targets" && request.method === "GET") {
    const session = await requireSession({ store, request, nowMs });
    if (!session) return json(null, 401, { error: "session-required" });
    const beats = await store.heartbeatStates(90_000, nowMs);
    const online = Object.fromEntries(beats.map((row) => [row.target, row.online === 1]));
    return json(null, 200, {
      targets: targetsForApp(env).map((target) => ({ ...target, online: Boolean(online[target.id]) })),
      privateDiscoveryUrls: privateDiscoveryUrlsForApp(env),
    });
  }

  if (url.pathname === "/api/link/send" && request.method === "POST") {
    const session = await requireSession({ store, request, nowMs });
    if (!session) return json(null, 401, { error: "session-required" });
    if (await requestRateLimited({
      store,
      request,
      subject: `session:${session.tokenHash}`,
      scope: "send",
      bucket: Math.floor(nowMs / 60_000),
      max: Number(env.RATE_SEND_PER_MINUTE) || 30,
    })) {
      return json(null, 429, { error: "rate-limited" });
    }
    const body = await request.json().catch(() => ({}));
    const clientMessageId = String(body.clientMessageId || "");
    const target = String(body.target || "");
    const kind = body.kind === "voice" ? "voice" : "text";
    const maxChars = Number(env.MAX_TEXT_CHARS) || 4000;
    const rawText = String(body.text ?? "").trim();
    let voiceRef = null;
    if (kind === "voice") {
      voiceRef = String(body.voiceRef || "");
      if (!/^voice\/[\w-]{8,80}\.m4a$/u.test(voiceRef)) {
        return json(null, 400, { error: "voiceRef-invalid" });
      }
      const object = await env.LINK_VOICE.get(voiceRef);
      if (!object || object.customMetadata?.identityId !== session.identityId) {
        return json(null, 404, { error: "voice-not-found" });
      }
    }
    const allowed = targetsForApp(env).some((entry) => entry.id === target);
    const existing = await store.getMessageForApp(clientMessageId, session.identityId);
    const rejectInput = async (status, error) => {
      await deleteUnusedVoice(env, voiceRef, existing);
      return json(null, status, { error });
    };
    if (!UUID_RE.test(clientMessageId)) {
      return rejectInput(400, "clientMessageId-uuid-required");
    }
    if (!allowed) return rejectInput(403, "unknown-target");
    if (rawText.length > maxChars) {
      return rejectInput(400, `text-over-${maxChars}-chars`);
    }
    if (kind === "text" && !rawText) return rejectInput(400, "text-required");
    const decision = sendDecision({
      existing, clientMessageId, target, kind, body: rawText, voiceRef,
    });
    if (decision.action === "reject") {
      await deleteUnusedVoice(env, voiceRef, existing);
      return json(null, decision.status, { error: decision.reason });
    }
    let responseStatus = decision.status;
    let replayed = decision.action === "replay";
    if (decision.action === "insert") {
      const inserted = await store.insertMessage({
        clientMessageId,
        identityId: session.identityId,
        target,
        kind,
        body: rawText,
        voiceRef,
        nowMs,
      });
      if (!inserted) {
        const raced = await store.getMessageForApp(clientMessageId, session.identityId);
        const racedDecision = sendDecision({
          existing: raced, clientMessageId, target, kind, body: rawText, voiceRef,
        });
        if (racedDecision.action !== "replay") {
          await deleteUnusedVoice(env, voiceRef, raced);
          return json(null, 409, { error: "idempotency-key-reused" });
        }
        replayed = true;
        responseStatus = 200;
      }
    }
    return json(null, responseStatus, { state: "queued", target, replayed });
  }

  if (url.pathname === "/api/link/events" && request.method === "GET") {
    const session = await requireSession({ store, request, nowMs });
    if (!session) return json(null, 401, { error: "session-required" });
    const afterSeq = Number(url.searchParams.get("after") || 0) || 0;
    const events = await store.eventsAfter({ afterSeq, limit: 50, identityId: session.identityId });
    const beats = await store.heartbeatStates(90_000, nowMs);
    return json(null, 200, {
      events,
      heartbeats: Object.fromEntries(beats.map((row) => [row.target, row.online === 1])),
      now: nowMs,
    });
  }

  if (url.pathname === "/api/link/voice/upload" && request.method === "POST") {
    const session = await requireSession({ store, request, nowMs });
    if (!session) return json(null, 401, { error: "session-required" });
    if (await requestRateLimited({
      store,
      request,
      subject: `session:${session.tokenHash}`,
      scope: "voice-upload",
      bucket: Math.floor(nowMs / 60_000),
      max: Number(env.RATE_UPLOAD_PER_MINUTE) || 10,
    })) {
      return json(null, 429, { error: "rate-limited" });
    }
    const body = await request.json().catch(() => ({}));
    const audioB64 = String(body.audio || "");
    const maxBytes = Number(env.MAX_AUDIO_BYTES) || 5 * 1024 * 1024;
    if (audioB64.length < 16 || audioB64.length > Math.ceil(maxBytes * 1.4)) {
      return json(null, 400, { error: "audio-size-out-of-bounds" });
    }
    const bytes = Uint8Array.from(atob(audioB64), (c) => c.charCodeAt(0));
    if (bytes.length > maxBytes) return json(null, 400, { error: "audio-size-out-of-bounds" });
    const voiceRef = `voice/${crypto.randomUUID()}.m4a`;
    await env.LINK_VOICE.put(voiceRef, bytes, {
      httpMetadata: { contentType: "audio/mp4" },
      customMetadata: { identityId: session.identityId, uploadedAt: new Date(nowMs).toISOString() },
    });
    return json(null, 201, { voiceRef, sizeBytes: bytes.length });
  }

  if (url.pathname.startsWith("/api/link/voice/") && request.method === "GET") {
    return null; // connector download lives in routes-connector.mjs
  }

  return null;
}
