// Review regression pins for #201: B1 identity privacy, B2 receipt ack,
// B3 atomic PKCE exchange, B4 immutable-first publication, rate limit.

import { expect, feature, component } from "bdd-vitest";
import worker from "./index.mjs";
import { createTestDb } from "./testdb.mjs";
import { createLinkStore } from "./store.mjs";
import { sha256Hex, pkceChallenge } from "./util.mjs";
import { runLinkConnectorCycle } from "../../channels/link-connector.mjs";
import { createDeliveryQueue } from "../../core/delivery-queue.mjs";
import { releaseUploadPlan } from "../scripts/publish-release.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const NOW = Date.now();

function makeEnv() {
  const objects = new Map();
  return {
    LINK_DB: createTestDb(),
    LINK_VOICE: {
      put: async (key, body, meta) => { objects.set(key, { body, customMetadata: meta?.customMetadata || {} }); },
      get: async (key) => objects.get(key) || null,
      delete: async (key) => { objects.delete(key); },
    },
    LINK_RELEASES: { get: async () => null },
    V1D_AUTH_ORIGIN: "x",
    V1D_AUTH_APP_ID: "x",
    V1D_AUTH_CLIENT_SECRET: "x",
    V1D_AUTH_STATE_SECRET: "ab".repeat(32),
    V1D_AUTH_CALLBACK_URL: "x",
    CONNECTOR_TOKEN_WSL: "wsl-token",
    CONNECTOR_TOKEN_WINDOWS: "win-token",
    LINK_TARGETS: "lsrc:3|L-source 3,lsrc:10|L-source 10,windows|Windows rescue",
    CONNECTOR_TARGETS_WSL: "lsrc:3,lsrc:10",
    CONNECTOR_LEASE_SECONDS: "60",
    SESSION_TTL_SECONDS: "3600",
    MAX_TEXT_CHARS: "4000",
    MAX_AUDIO_BYTES: "5242880",
    RATE_SEND_PER_MINUTE: "30",
  };
}

const req = (url, { method = "GET", token = null, body = null, ip = null } = {}) =>
  new Request(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...(ip ? { "cf-connecting-ip": ip } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

async function seedSession(store, token, identityId) {
  await store.insertSession({ tokenHash: await sha256Hex(token), identityId, nowMs: NOW, ttlSeconds: 3600 });
}

feature("B1: identity privacy", () => {
  component("another session never reads bodies, events, or voice objects", {
    given: ["messages and a voice object owned by identity A", async () => {
      const env = makeEnv();
      const store = createLinkStore(env.LINK_DB);
      await seedSession(store, "lnk_a", "person-a");
      await seedSession(store, "lnk_b", "person-b");
      await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", token: "lnk_a",
        body: { clientMessageId: crypto.randomUUID(), target: "lsrc:3", kind: "text", text: "A-PRIVATE" },
      }), env);
      const upload = await worker.fetch(req("https://link.v1d.io/api/link/voice/upload", {
        method: "POST", token: "lnk_a",
        body: { audio: Buffer.from("VOICE-A-1234").toString("base64"), filename: "a.m4a" },
      }), env);
      const { voiceRef } = await upload.json();
      return { env, store, voiceRef };
    }],
    when: ["identity B reads events, replays A's id, and uses A's voice ref", async ({ env, store, voiceRef }) => {
      const aEvents = await worker.fetch(req("https://link.v1d.io/api/link/events?after=0", { token: "lnk_a" }), env);
      const bEvents = await worker.fetch(req("https://link.v1d.io/api/link/events?after=0", { token: "lnk_b" }), env);
      const aMessage = (await store.eventsAfter({ afterSeq: 0 })).find((row) => row.body === "A-PRIVATE");
      const bReplay = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", token: "lnk_b",
        body: { clientMessageId: aMessage.clientMessageId, target: "lsrc:3", kind: "text", text: "B försöker" },
      }), env);
      const bVoiceSend = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", token: "lnk_b",
        body: {
          clientMessageId: crypto.randomUUID(), target: "lsrc:3", kind: "voice",
          voiceRef,
        },
      }), env);
      return {
        aEvents: await aEvents.json(),
        bEvents: await bEvents.json(),
        bReplay,
        bVoiceSend,
      };
    }],
    then: ["B sees an empty timeline, a neutral 409, and a 404 on A's voice", (r) => {
      expect(r.aEvents.events.some((event) => event.body === "A-PRIVATE")).toBe(true);
      expect(r.bEvents.events).toHaveLength(0);
      expect(r.bReplay.status).toBe(409);
      expect(r.bVoiceSend.status).toBe(404);
    }],
  });
});

feature("B2: the connector acks only on the broker's acknowledged receipt", () => {
  component("an enqueued-but-unacknowledged job produces no ack and no reply", {
    given: ["a queue that never acknowledges and one mailbox message", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-link-b2-"));
      const statePath = join(root, "connector.json");
      const posts = [];
      const fetchImpl = async (url, init) => {
        posts.push({ url, body: JSON.parse(init.body || "{}") });
        if (url.includes("/connector/poll")) return { ok: true, json: async () => ({ messages: [{ clientMessageId: "m-b2", target: "lsrc:3", kind: "text", body: "hej" }] }) };
        return { ok: true, json: async () => ({}) };
      };
      return {
        root,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
        posts,
        deps: {
          fetchImpl,
          linkBase: "https://link.v1d.io",
          token: "wsl-token",
          targets: ["lsrc:3"],
          agent: { hasResponseForPrompt: () => false, getResponseStreamWithRaw: async () => ({ items: [] }) },
          deliveryBroker: { enqueue: () => ({ id: "job-b2" }) },
          deliveryQueue: { read: () => ({ status: "submitted" }) },
          statePath,
          receiptTimeoutMs: 1,
          sleep: async () => {},
        },
      };
    }],
    when: ["running the cycle", async (ctx) => runLinkConnectorCycle(ctx.deps)],
    then: ["zero acks and zero replies, the message stays recoverable", (result, ctx) => {
      expect(result.handled).toBe(0);
      expect(ctx.posts.filter((p) => p.url.includes("/ack"))).toHaveLength(0);
      expect(ctx.posts.filter((p) => p.url.includes("/reply"))).toHaveLength(0);
      expect(ctx.posts.filter((p) => p.url.includes("/fail"))).toHaveLength(0);
      ctx.cleanup();
    }],
  });

  component("cancelled and refused queue attempts never terminalize the mailbox message", {
    given: ["one cancelled receipt and one enqueue refusal", () => {
      const makeCase = (suffix, overrides) => {
        const root = mkdtempSync(join(tmpdir(), `amux-link-b2-${suffix}-`));
        const posts = [];
        return {
          root,
          posts,
          deps: {
            fetchImpl: async (url, init) => {
              posts.push({ url, body: JSON.parse(init.body || "{}") });
              if (url.includes("/connector/poll")) {
                return {
                  ok: true,
                  json: async () => ({
                    messages: [{
                      clientMessageId: `m-${suffix}`,
                      target: "lsrc:3",
                      kind: "text",
                      body: "hej",
                    }],
                  }),
                };
              }
              return { ok: true, json: async () => ({}) };
            },
            linkBase: "https://link.v1d.io",
            token: "wsl-token",
            targets: ["lsrc:3"],
            agent: {
              hasResponseForPrompt: () => false,
              getResponseStreamWithRaw: async () => ({ items: [] }),
            },
            deliveryBroker: { enqueue: () => ({ id: `job-${suffix}` }) },
            deliveryQueue: { read: () => ({ status: "cancelled" }) },
            statePath: join(root, "connector.json"),
            receiptTimeoutMs: 1,
            sleep: async () => {},
            ...overrides,
          },
        };
      };
      return [
        makeCase("cancelled"),
        makeCase("refused", {
          deliveryBroker: { enqueue: () => { throw new Error("target-refused"); } },
        }),
      ];
    }],
    when: ["running both cycles", async (cases) => {
      const results = [];
      for (const item of cases) results.push(await runLinkConnectorCycle(item.deps));
      return { cases, results };
    }],
    then: ["both stay unacked and recoverable for lease reclaim", ({ cases, results }) => {
      expect(results.every((result) => result.handled === 0)).toBe(true);
      for (const item of cases) {
        expect(item.posts.some((post) => /\/(?:ack|reply|fail)$/u.test(new URL(post.url).pathname))).toBe(false);
        rmSync(item.root, { recursive: true, force: true });
      }
    }],
  });

  component("a reclaimed lease keeps the stable key until cancellation is proven", {
    given: ["attempt one twice, then reclaimed attempt two over the real durable queue", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-link-b2-generation-"));
      const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => NOW });
      const mailboxAttempts = [1, 1, 2];
      const posts = [];
      const enqueues = [];
      const deliveryBroker = {
        enqueue(request) {
          const job = queue.enqueue(request);
          enqueues.push({ id: job.id, key: request.idempotencyKey });
          const current = queue.read(request.agentName, request.pane, job.id);
          if (request.idempotencyKey === "link:m-generation" && current.status !== "cancelled") {
            queue.update(current, { status: "cancelled", terminalAt: NOW });
          }
          if (request.idempotencyKey.endsWith(":attempt:2") && current.status !== "acknowledged") {
            queue.update(current, { status: "acknowledged", acknowledgedAt: NOW });
          }
          return queue.read(request.agentName, request.pane, job.id);
        },
      };
      return {
        root,
        posts,
        enqueues,
        deps: {
          fetchImpl: async (url, init) => {
            posts.push({ url, body: JSON.parse(init.body || "{}") });
            if (url.includes("/connector/poll")) {
              return {
                ok: true,
                json: async () => ({
                  messages: [{
                    clientMessageId: "m-generation",
                    target: "lsrc:3",
                    kind: "text",
                    body: "hej",
                    attempts: mailboxAttempts.shift(),
                  }],
                }),
              };
            }
            return { ok: true, json: async () => ({}) };
          },
          linkBase: "https://link.v1d.io",
          token: "wsl-token",
          targets: ["lsrc:3"],
          agent: {
            hasResponseForPrompt: () => true,
            getResponseStreamWithRaw: async () => ({
              items: [{ type: "text", content: "svaret" }],
            }),
          },
          deliveryBroker,
          deliveryQueue: queue,
          statePath: join(root, "connector.json"),
          receiptTimeoutMs: 1,
          sleep: async () => {},
        },
      };
    }],
    when: ["running both same-lease cycles and the reclaimed generation", async (ctx) => {
      const results = [];
      for (let index = 0; index < 3; index += 1) {
        results.push(await runLinkConnectorCycle(ctx.deps));
      }
      return { ctx, results };
    }],
    then: ["the stable key deduplicates live jobs and only a cancelled job rotates", ({ ctx, results }) => {
      expect(results.map((result) => result.handled)).toEqual([0, 0, 1]);
      expect(ctx.enqueues.map((entry) => entry.key)).toEqual([
        "link:m-generation",
        "link:m-generation:attempt:1",
        "link:m-generation",
        "link:m-generation:attempt:1",
        "link:m-generation",
        "link:m-generation:attempt:2",
      ]);
      expect(ctx.enqueues[0].id).toBe(ctx.enqueues[2].id);
      expect(ctx.enqueues[0].id).toBe(ctx.enqueues[4].id);
      expect(ctx.enqueues[1].id).toBe(ctx.enqueues[3].id);
      expect(ctx.enqueues[5].id).not.toBe(ctx.enqueues[0].id);
      expect(ctx.posts.filter((post) => post.url.includes("/ack"))).toHaveLength(1);
      expect(ctx.posts.filter((post) => post.url.includes("/reply"))).toHaveLength(1);
      expect(ctx.posts.filter((post) => post.url.includes("/fail"))).toHaveLength(0);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("an acknowledged job acks and replies exactly once", {
    given: ["a queue that acknowledges and a pane answer", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-link-b2b-"));
      const statePath = join(root, "connector.json");
      const posts = [];
      const fetchImpl = async (url, init) => {
        posts.push({ url, body: JSON.parse(init.body || "{}") });
        if (url.includes("/connector/poll")) return { ok: true, json: async () => ({ messages: [{ clientMessageId: "m-b2b", target: "lsrc:3", kind: "text", body: "hej" }] }) };
        return { ok: true, json: async () => ({}) };
      };
      return {
        root,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
        posts,
        deps: {
          fetchImpl,
          linkBase: "https://link.v1d.io",
          token: "wsl-token",
          targets: ["lsrc:3"],
          agent: {
            hasResponseForPrompt: () => true,
            getResponseStreamWithRaw: async () => ({ items: [{ type: "text", content: "svaret" }] }),
          },
          deliveryBroker: { enqueue: () => ({ id: "job-b2b" }) },
          deliveryQueue: { read: () => ({ status: "acknowledged", acknowledgedAt: NOW }) },
          statePath,
          receiptTimeoutMs: 1,
          sleep: async () => {},
        },
      };
    }],
    when: ["running the cycle", async (ctx) => runLinkConnectorCycle(ctx.deps)],
    then: ["exactly one ack and one reply after the receipt", (result, ctx) => {
      expect(result.handled).toBe(1);
      expect(ctx.posts.filter((p) => p.url.includes("/ack"))).toHaveLength(1);
      expect(ctx.posts.filter((p) => p.url.includes("/reply"))).toHaveLength(1);
      ctx.cleanup();
    }],
  });
});

feature("B3: a wrong verifier never burns the one-time code", () => {
  component("wrong verifier 403, correct verifier still succeeds after", {
    given: ["a pending exchange code", async () => {
      const env = makeEnv();
      const store = createLinkStore(env.LINK_DB);
      const verifier = "v".repeat(64);
      await store.insertExchangeCode({
        codeHash: await sha256Hex("xch_b3"),
        challenge: await pkceChallenge(verifier),
        identityId: "3f7c2a1e-1111-4111-8111-aaaaaaaaaaaa",
        verifiedEmail: "m@example.se",
        nowMs: NOW,
        ttlSeconds: 60,
      });
      return { env, verifier };
    }],
    when: ["exchanging wrong then right", async ({ env, verifier }) => {
      const wrong = await worker.fetch(req("https://link.v1d.io/auth/exchange", {
        method: "POST", body: { code: "xch_b3", verifier: "w".repeat(64) },
      }), env);
      const right = await worker.fetch(req("https://link.v1d.io/auth/exchange", {
        method: "POST", body: { code: "xch_b3", verifier },
      }), env);
      return { wrong, right, rightBody: await right.json() };
    }],
    then: ["the atomic compare-plus-consume keeps the code alive", (r) => {
      expect(r.wrong.status).toBe(403);
      expect(r.right.status).toBe(200);
      expect(r.rightBody.session).toMatch(/^lnk_/u);
    }],
  });
});

feature("B4: publication order is immutable-first", () => {
  component("apk first, signature second, manifest last", {
    given: ["a phone channel and version", () => ({ channel: "phone", versionCode: 42 })],
    when: ["building the upload plan", (ctx) => releaseUploadPlan(ctx).map((step) => step.put)],
    then: ["the manifest can never outrun its artifacts", (puts) => {
      expect(puts[0]).toContain("/app-42.apk");
      expect(puts[1]).toContain("manifest-v1.json.sig");
      expect(puts[2]).toContain("manifest-v1.json");
      expect(puts[2].endsWith(".sig")).toBe(false);
    }],
  });
});

feature("rate limit on send", () => {
  component("the 31st send in a minute is refused, next window resets", {
    given: ["a session under a rate cap of 30", async () => {
      const env = makeEnv();
      const store = createLinkStore(env.LINK_DB);
      await seedSession(store, "lnk_rate", "person-rate");
      return { env };
    }],
    when: ["sending 31 times", async ({ env }) => {
      const statuses = [];
      for (let index = 0; index < 31; index += 1) {
        const response = await worker.fetch(req("https://link.v1d.io/api/link/send", {
          method: "POST", token: "lnk_rate",
          body: { clientMessageId: crypto.randomUUID(), target: "lsrc:3", kind: "text", text: `m${index}` },
        }), env);
        statuses.push(response.status);
      }
      return statuses;
    }],
    then: ["30 accepted, then an honest 429", (statuses) => {
      expect(statuses.slice(0, 30).every((status) => status === 201)).toBe(true);
      expect(statuses[30]).toBe(429);
    }],
  });

  component("boundaries are per action and stale minute buckets are pruned", {
    given: ["one store with explicit minute buckets", () => {
      const db = createTestDb();
      return { db, store: createLinkStore(db) };
    }],
    when: ["crossing send's cap, using upload, advancing, and pruning", async ({ db, store }) => {
      const send = [];
      for (let index = 0; index < 31; index += 1) {
        send.push(await store.hitRateLimit({
          subject: "session:person-rate",
          scope: "send",
          bucket: 100,
          max: 30,
        }));
      }
      const upload = await store.hitRateLimit({
        subject: "session:person-rate",
        scope: "voice-upload",
        bucket: 100,
        max: 10,
      });
      const nextMinute = await store.hitRateLimit({
        subject: "session:person-rate",
        scope: "send",
        bucket: 101,
        max: 30,
      });
      await store.hitRateLimit({
        subject: "session:old-person",
        scope: "send",
        bucket: 1,
        max: 30,
      });
      await store.hitRateLimit({
        subject: "session:person-rate",
        scope: "send",
        bucket: 104,
        max: 30,
      });
      const retained = await db.prepare("SELECT COUNT(*) AS count FROM rate_windows").bind().first();
      return { send, upload, nextMinute, retained: retained.count };
    }],
    then: ["31 is over, upload is independent, the next minute resets, old rows disappear", (result) => {
      expect(result.send.slice(0, 30).every((limited) => limited === false)).toBe(true);
      expect(result.send[30]).toBe(true);
      expect(result.upload).toBe(false);
      expect(result.nextMinute).toBe(false);
      expect(result.retained).toBe(1);
    }],
  });

  component("connector polling is bounded independently", {
    given: ["a WSL connector with a two-poll cap", () => {
      const env = makeEnv();
      env.RATE_POLL_PER_MINUTE = "2";
      return { env };
    }],
    when: ["polling three times from one connector and source IP", async ({ env }) => {
      const statuses = [];
      for (let index = 0; index < 3; index += 1) {
        const response = await worker.fetch(req(
          "https://link.v1d.io/api/link/connector/poll?source=wsl",
          { method: "POST", token: "wsl-token", body: {}, ip: "192.0.2.10" },
        ), env);
        statuses.push(response.status);
      }
      return statuses;
    }],
    then: ["the exact boundary is two successes and one 429", (statuses) => {
      expect(statuses).toEqual([200, 200, 429]);
    }],
  });
});
