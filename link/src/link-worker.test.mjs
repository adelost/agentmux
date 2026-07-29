// Link worker integration: auth legs, session lifecycle, mailbox journey,
// connector scoping, and exact-once over the real router and schema.

import { expect, feature, component } from "bdd-vitest";
import worker from "./index.mjs";
import { createTestDb } from "./testdb.mjs";
import { openState, sealState } from "./auth.mjs";
import { pkceChallenge, sha256Hex } from "./util.mjs";

const SECRET = "ab".repeat(32);
const NOW = Date.now();

function makeEnv(overrides = {}) {
  return {
    LINK_DB: createTestDb(),
    V1D_AUTH_ORIGIN: "https://auth.v1d.io",
    V1D_AUTH_APP_ID: "agentmux-link",
    V1D_AUTH_CLIENT_SECRET: "client-secret",
    V1D_AUTH_STATE_SECRET: SECRET,
    V1D_AUTH_CALLBACK_URL: "https://link.v1d.io/auth/callback",
    CONNECTOR_TOKEN_WSL: "wsl-token",
    CONNECTOR_TOKEN_WINDOWS: "win-token",
    LINK_TARGETS: "lsrc:3|L-source 3,lsrc:10|L-source 10,windows|Windows rescue",
    LINK_PRIVATE_DISCOVERY_URLS:
      "https://relay.example.ts.net:8443,http://agentmux.local:8080",
    CONNECTOR_TARGETS_WSL: "lsrc:3,lsrc:10",
    CONNECTOR_LEASE_SECONDS: "60",
    SESSION_TTL_SECONDS: "2592000",
    EXCHANGE_CODE_TTL_SECONDS: "60",
    MAX_TEXT_CHARS: "4000",
    ...overrides,
  };
}

const req = (url, { method = "GET", token = null, body = null } = {}) =>
  new Request(url, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

const uuid = () => crypto.randomUUID();

async function seedIdentity(store, { identityId, email }) {
  await store.insertExchangeCode({
    codeHash: await sha256Hex("xch_test"),
    challenge: await pkceChallenge("v".repeat(64)),
    identityId,
    verifiedEmail: email,
    nowMs: NOW,
    ttlSeconds: 60,
  });
  // identities allowlist row goes straight into the table via a message-less path
  await store.insertMessage({ clientMessageId: uuid(), identityId, target: "lsrc:3", kind: "text", body: "seed", nowMs: NOW });
}

feature("sealed login state", () => {
  component("round-trips and refuses tampering", {
    given: ["a sealed transaction", async () => ({
      state: await sealState(SECRET, { verifier: "v", challenge: "c", expiresAt: NOW + 1000 }),
    })],
    when: ["opening intact and forged", async (ctx) => ({
      state: ctx.state,
      intact: await openState(SECRET, ctx.state),
      forged: await openState(SECRET, `${ctx.state.slice(0, -4)}AAAA`),
      wrongKey: await openState("cd".repeat(32), ctx.state),
    })],
    then: ["only the untampered original opens", (r) => {
      expect(r.intact).toMatchObject({ verifier: "v", challenge: "c" });
      expect(r.forged).toBeNull();
      expect(r.wrongKey).toBeNull();
      expect(r.state).toMatch(/^v1_[A-Za-z0-9_-]+$/u);
    }],
  });
});

feature("deployment health", () => {
  component("fails closed until every live binding and secret is present", {
    given: ["one complete and one incomplete deployment env", () => {
      const complete = makeEnv({
        LINK_VOICE: { get: async () => null },
        LINK_RELEASES: { get: async () => null },
        V1D_AUTH_CLIENT_SECRET: "c".repeat(32),
        CONNECTOR_TOKEN_WSL: "w".repeat(32),
        CONNECTOR_TOKEN_WINDOWS: "x".repeat(32),
      });
      return { complete, incomplete: { ...complete, CONNECTOR_TOKEN_WINDOWS: "" } };
    }],
    when: ["reading both health endpoints", async ({ complete, incomplete }) => ({
      complete: await worker.fetch(req("https://link.v1d.io/healthz"), complete),
      incomplete: await worker.fetch(req("https://link.v1d.io/healthz"), incomplete),
    })],
    then: ["only the fully configured worker is healthy", async (result) => {
      expect(result.complete.status).toBe(200);
      expect(await result.complete.json()).toEqual({ ok: true, service: "agentmux-link" });
      expect(result.incomplete.status).toBe(503);
      expect(await result.incomplete.json()).toEqual({ ok: false, service: "agentmux-link" });
    }],
  });
});

feature("mailbox journey over the real router", () => {
  component("send to reply with replay, conflict, and scoped connector auth", {
    given: ["an env and one connector token", () => ({ env: makeEnv(), session: "lnk_test" })],
    when: ["driving a full journey", async ({ env, session }) => {
      const id = uuid();
      const auth = { token: session };
      // sessions are hashed in store; seed one directly
      const store = (await import("./store.mjs")).createLinkStore(env.LINK_DB);
      await store.insertSession({ tokenHash: await sha256Hex(session), identityId: "p-1", nowMs: NOW, ttlSeconds: 3600 });

      const send = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", ...auth, body: { clientMessageId: id, target: "lsrc:3", kind: "text", text: "hej" },
      }), env);
      const replay = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", ...auth, body: { clientMessageId: id, target: "lsrc:3", kind: "text", text: "hej" },
      }), env);
      const conflict = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", ...auth, body: { clientMessageId: id, target: "lsrc:3", kind: "text", text: "annat" },
      }), env);
      const badTarget = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", ...auth, body: { clientMessageId: uuid(), target: "claw:3", kind: "text", text: "x" },
      }), env);
      const noSession = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", body: { clientMessageId: uuid(), target: "lsrc:3", kind: "text", text: "x" },
      }), env);

      const badConnector = await worker.fetch(req("https://link.v1d.io/api/link/connector/poll", {
        method: "POST", token: "wrong", body: {},
      }), env);
      const windowsScope = await worker.fetch(req("https://link.v1d.io/api/link/connector/poll?source=wsl", {
        method: "POST", token: "wsl-token", body: {},
      }), env);
      const spoofedConnector = await worker.fetch(req("https://link.v1d.io/api/link/connector/ack", {
        method: "POST", token: "wsl-token", body: { clientMessageId: id, connectorId: "wsl-2" },
      }), env);
      const windowsId = uuid();
      await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", ...auth,
        body: { clientMessageId: windowsId, target: "windows", kind: "text", text: "foreign" },
      }), env);
      const foreignTarget = await worker.fetch(req("https://link.v1d.io/api/link/connector/fail", {
        method: "POST", token: "wsl-token",
        body: { clientMessageId: windowsId, connectorId: "wsl-1", error: "not mine" },
      }), env);
      const ack = await worker.fetch(req("https://link.v1d.io/api/link/connector/ack", {
        method: "POST", token: "wsl-token", body: { clientMessageId: id, connectorId: "wsl-1" },
      }), env);
      const reply = await worker.fetch(req("https://link.v1d.io/api/link/connector/reply", {
        method: "POST", token: "wsl-token", body: { clientMessageId: id, connectorId: "wsl-1", body: "svar tillbaka" },
      }), env);
      const events = await worker.fetch(req("https://link.v1d.io/api/link/events?after=0", auth), env);
      return {
        send, replay, conflict, badTarget, noSession,
        badConnector, windowsScope, spoofedConnector, foreignTarget, ack, reply,
        events: await events.json(),
      };
    }],
    then: ["exactly one delivery, honest rejections everywhere", async (r) => {
      expect(r.send.status).toBe(201);
      expect(r.replay.status).toBe(200);
      expect((await r.replay.json()).replayed).toBe(true);
      expect(r.conflict.status).toBe(409);
      expect(r.badTarget.status).toBe(403);
      expect(r.noSession.status).toBe(401);
      expect(r.badConnector.status).toBe(401);
      expect(r.windowsScope.status).toBe(200);
      expect(r.spoofedConnector.status).toBe(403);
      expect(r.foreignTarget.status).toBe(403);
      const claimed = (await r.windowsScope.json()).messages;
      expect(claimed).toHaveLength(1);
      expect(claimed[0]).toMatchObject({ clientMessageId: claimed[0].clientMessageId, target: "lsrc:3", state: "leased" });
      expect(claimed.every((m) => ["lsrc:3", "lsrc:10"].includes(m.target))).toBe(true);
      expect(r.ack.status).toBe(200);
      expect(r.reply.status).toBe(200);
      const states = r.events.events.map((event) => [event.clientMessageId, event.state]);
      expect(states).toContainEqual([expect.any(String), "replied"]);
      expect(r.events.heartbeats["lsrc:3"]).toBe(true);
    }],
  });
});

feature("auth exchange leg", () => {
  component("single-use code, verifier check, bind-once, revoke", {
    given: ["an env with a pending exchange code", async () => {
      const env = makeEnv();
      const { createLinkStore } = await import("./store.mjs");
      const store = createLinkStore(env.LINK_DB);
      const verifier = "v".repeat(64);
      await store.insertExchangeCode({
        codeHash: await sha256Hex("xch_1"),
        challenge: await pkceChallenge(verifier),
        identityId: "3f7c2a1e-1111-4111-8111-aaaaaaaaaaaa",
        verifiedEmail: "m@example.se",
        nowMs: NOW,
        ttlSeconds: 60,
      });
      return { env, verifier };
    }],
    when: ["exchanging twice, with a wrong verifier, then revoking", async ({ env, verifier }) => {
      const exchange = () => worker.fetch(req("https://link.v1d.io/auth/exchange", {
        method: "POST", body: { code: "xch_1", verifier },
      }), env);
      const first = await exchange();
      const firstBody = await first.json();
      const second = await exchange();
      const wrongVerifier = await worker.fetch(req("https://link.v1d.io/auth/exchange", {
        method: "POST", body: { code: "xch_1", verifier: "w".repeat(64) },
      }), env);
      const session = firstBody.session;
      const targets = await worker.fetch(req("https://link.v1d.io/api/link/targets", { token: session }), env);
      const targetsBody = await targets.clone().json();
      await worker.fetch(req("https://link.v1d.io/auth/revoke", { method: "POST", token: session }), env);
      const afterRevoke = await worker.fetch(req("https://link.v1d.io/api/link/targets", { token: session }), env);
      return { first, firstBody, second, wrongVerifier, targets, targetsBody, afterRevoke };
    }],
    then: ["exactly one session, dead after use and after revoke", async (r) => {
      expect(r.first.status).toBe(200);
      expect(r.firstBody.session).toMatch(/^lnk_/u);
      expect(r.firstBody.targets.map((t) => t.id)).toEqual(["lsrc:3", "lsrc:10", "windows"]);
      expect(r.firstBody.privateDiscoveryUrls).toEqual([
        "https://relay.example.ts.net:8443",
        "http://agentmux.local:8080",
      ]);
      expect(r.second.status).toBe(403);
      expect(r.wrongVerifier.status).toBe(403);
      expect(r.targets.status).toBe(200);
      expect(r.targetsBody.privateDiscoveryUrls).toEqual(r.firstBody.privateDiscoveryUrls);
      expect(r.afterRevoke.status).toBe(401);
    }],
  });

  component("a valid login for a non-allowlisted identity is refused (E)", {
    given: ["a sealed callback for a stranger and a mocked broker", async () => {
      const env = makeEnv();
      const verifier = "broker-verifier";
      const state = await sealState(SECRET, {
        verifier,
        challenge: "c",
        client: "android",
        expiresAt: Date.now() + 60_000,
      });
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(JSON.stringify({
        principal: { id: "9e7c2a1e-9999-4111-8111-bbbbbbbbbbbb", name: "Stranger" },
      }), { status: 200, headers: { "content-type": "application/json" } });
      return { env, state, restore: () => { globalThis.fetch = realFetch; } };
    }],
    when: ["hitting the callback", async ({ env, state, restore }) => {
      const response = await worker.fetch(
        req(`https://link.v1d.io/auth/callback?code=once&state=${encodeURIComponent(state)}`),
        env,
      );
      restore();
      return response;
    }],
    then: ["identity-not-allowed, no session minted", async (response) => {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("identity-not-allowed");
    }],
  });

  component("the broker's verifiedEmail claim binds locally while central authorization fields are ignored", {
    given: ["an allowlisted identity and the real broker response shape", async () => {
      const env = makeEnv();
      const identityId = "7e7c2a1e-7777-4111-8111-cccccccccccc";
      const appVerifier = "a".repeat(64);
      await env.LINK_DB.prepare(
        "INSERT INTO identities(identityId, label, createdAt) VALUES (?, ?, ?)",
      ).bind(identityId, "Link User", NOW).run();
      const state = await sealState(SECRET, {
        verifier: "broker-verifier",
        challenge: await pkceChallenge(appVerifier),
        client: "android",
        expiresAt: Date.now() + 60_000,
      });
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => Response.json({
        principal: {
          id: identityId,
          name: "Link User",
          verifiedEmail: "link@example.com",
          isOwner: true,
          memberships: [{ resourceId: "central", role: "editor" }],
          membershipRevision: 9,
        },
      });
      return {
        env, identityId, state, appVerifier,
        restore: () => { globalThis.fetch = realFetch; },
      };
    }],
    when: ["completing and exchanging the identity callback", async ({
      env, identityId, state, appVerifier, restore,
    }) => {
      const response = await worker.fetch(
        req(`https://link.v1d.io/auth/callback?code=once&state=${encodeURIComponent(state)}`),
        env,
      );
      restore();
      const html = await response.text();
      const code = html.match(/xch_[0-9a-f]+/u)?.[0];
      const exchange = await worker.fetch(req("https://link.v1d.io/auth/exchange", {
        method: "POST",
        body: { code, verifier: appVerifier },
      }), env);
      const { createLinkStore } = await import("./store.mjs");
      const binding = await createLinkStore(env.LINK_DB).bindingFor(identityId);
      return { response, exchange, binding };
    }],
    then: ["the local claim is retained without importing central roles", (result) => {
      expect(result.response.status).toBe(200);
      expect(result.exchange.status).toBe(200);
      expect(result.binding).toMatchObject({ verifiedEmail: "link@example.com" });
      expect(result.binding).not.toHaveProperty("isOwner");
      expect(result.binding).not.toHaveProperty("memberships");
    }],
  });
});
