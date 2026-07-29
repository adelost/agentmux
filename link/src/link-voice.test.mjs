// Voice path: bounded upload, connector download, terminal retention.

import { expect, feature, component } from "bdd-vitest";
import worker from "./index.mjs";
import { createTestDb } from "./testdb.mjs";
import { createLinkStore } from "./store.mjs";
import { sha256Hex } from "./util.mjs";

const NOW = Date.now();

function makeEnv() {
  const objects = new Map();
  return {
    env: {
      LINK_DB: createTestDb(),
      LINK_VOICE: {
        put: async (key, bytes, meta) => {
          objects.set(key, { body: bytes, customMetadata: meta?.customMetadata || {} });
        },
        get: async (key) => objects.get(key) || null,
        delete: async (key) => { objects.delete(key); },
      },
      objects,
      LINK_RELEASES: { get: async () => null },
      V1D_AUTH_ORIGIN: "https://auth.v1d.io",
      V1D_AUTH_APP_ID: "agentmux-link",
      V1D_AUTH_CLIENT_SECRET: "x",
      V1D_AUTH_STATE_SECRET: "ab".repeat(32),
      V1D_AUTH_CALLBACK_URL: "https://link.v1d.io/auth/callback",
      CONNECTOR_TOKEN_WSL: "wsl-token",
      CONNECTOR_TOKEN_WINDOWS: "win-token",
      LINK_TARGETS: "lsrc:3|L-source 3,lsrc:10|L-source 10,windows|Windows rescue",
      CONNECTOR_TARGETS_WSL: "lsrc:3,lsrc:10",
      CONNECTOR_LEASE_SECONDS: "60",
      SESSION_TTL_SECONDS: "3600",
      MAX_TEXT_CHARS: "4000",
      MAX_AUDIO_BYTES: "5242880",
    },
  };
}

const req = (url, { method = "GET", token = null, body = null, raw = false } = {}) =>
  new Request(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body && !raw ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: raw ? body : JSON.stringify(body) } : {}),
  });

feature("voice upload and retention", () => {
  component("upload, voice send, connector download, and reply deletes the object", {
    given: ["an env and a session", async () => {
      const { env } = makeEnv();
      const store = createLinkStore(env.LINK_DB);
      await store.insertSession({ tokenHash: await sha256Hex("lnk_voice"), identityId: "p-1", nowMs: NOW, ttlSeconds: 3600 });
      return env;
    }],
    when: ["driving the voice journey", async (env) => {
      const audio = btoa("FAKE-VOICE-BYTES");
      const upload = await worker.fetch(req("https://link.v1d.io/api/link/voice/upload", {
        method: "POST", token: "lnk_voice", body: { audio, filename: "ptt.m4a" },
      }), env);
      const { voiceRef } = await upload.json();
      const send = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", token: "lnk_voice",
        body: { clientMessageId: crypto.randomUUID(), target: "lsrc:3", kind: "voice", voiceRef },
      }), env);
      const download = await worker.fetch(req(`https://link.v1d.io/api/link/voice/${voiceRef}`, { token: "wsl-token" }), env);
      const claimed = await worker.fetch(req("https://link.v1d.io/api/link/connector/poll?source=wsl", {
        method: "POST", token: "wsl-token", body: {},
      }), env);
      const messages = (await claimed.json()).messages;
      const ack = await worker.fetch(req("https://link.v1d.io/api/link/connector/ack", {
        method: "POST", token: "wsl-token",
        body: { clientMessageId: messages[0].clientMessageId, connectorId: "wsl-1" },
      }), env);
      const reply = await worker.fetch(req("https://link.v1d.io/api/link/connector/reply", {
        method: "POST", token: "wsl-token",
        body: { clientMessageId: messages[0].clientMessageId, connectorId: "wsl-1", body: "[transkript] hej" },
      }), env);
      const afterDelete = await worker.fetch(req(`https://link.v1d.io/api/link/voice/${voiceRef}`, { token: "wsl-token" }), env);
      const oversized = await worker.fetch(req("https://link.v1d.io/api/link/voice/upload", {
        method: "POST", token: "lnk_voice", body: { audio: "A".repeat(8 * 1024 * 1024), filename: "big.m4a" },
      }), env);
      const noSession = await worker.fetch(req("https://link.v1d.io/api/link/voice/upload", {
        method: "POST", body: { audio, filename: "x.m4a" },
      }), env);
      return { upload, voiceRef, send, download, ack, reply, afterDelete, oversized, noSession };
    }],
    then: ["full voice contract, honest bounds", async (r) => {
      expect(r.upload.status).toBe(201);
      expect(r.voiceRef).toMatch(/^voice\/[\w-]+\.m4a$/u);
      expect(r.send.status).toBe(201);
      expect(r.download.status).toBe(200);
      expect(r.download.headers.get("content-type")).toBe("audio/mp4");
      expect(new TextDecoder().decode(await r.download.arrayBuffer())).toBe("FAKE-VOICE-BYTES");
      expect(r.ack.status).toBe(200);
      expect(r.reply.status).toBe(200);
      expect(r.afterDelete.status).toBe(404); // terminal retention deleted it
      expect(r.oversized.status).toBe(400);
      expect(r.noSession.status).toBe(401);
    }],
  });

  component("voice send requires an existing object", {
    given: ["an env and a session", async () => {
      const { env } = makeEnv();
      const store = createLinkStore(env.LINK_DB);
      await store.insertSession({ tokenHash: await sha256Hex("lnk_voice2"), identityId: "p-1", nowMs: NOW, ttlSeconds: 3600 });
      return env;
    }],
    when: ["sending a voice message with a dangling ref", async (env) =>
      worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", token: "lnk_voice2",
        body: { clientMessageId: crypto.randomUUID(), target: "lsrc:3", kind: "voice", voiceRef: "voice/deadbeef-1234.m4a" },
      }), env)],
    then: ["404, never a queued ghost", async (response) => {
      expect(response.status).toBe(404);
    }],
  });
});
