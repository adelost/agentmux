// The app's target list is the fleet's, not a Cloudflare variable (row 184,
// Mattias 2026-09-17: "man ska kunna välja alla kanaler"). What the connector
// announces on poll is what TALK TO shows and what send accepts.

import { expect, feature, component } from "bdd-vitest";
import worker from "./index.mjs";
import { createTestDb } from "./testdb.mjs";
import { sha256Hex } from "./util.mjs";
import { createLinkStore } from "./store.mjs";

const SECRET = "ab".repeat(32);
const NOW = Date.now();
const SESSION = "lnk_fleet_test";

function makeEnv(overrides = {}) {
  return {
    LINK_DB: createTestDb(),
    LINK_AUTH_ORIGIN: "https://identity.example.com",
    LINK_AUTH_APP_ID: "agentmux-link",
    LINK_AUTH_CLIENT_SECRET: "client-secret",
    LINK_AUTH_STATE_SECRET: SECRET,
    LINK_AUTH_CALLBACK_URL: "https://link.example.com/auth/callback",
    CONNECTOR_TOKEN_WSL: "wsl-token",
    CONNECTOR_TOKEN_WINDOWS: "win-token",
    LINK_TARGETS: "lsrc:3|L-source 3,lsrc:10|L-source 10,windows|Windows rescue",
    CONNECTOR_TARGETS_WSL: "lsrc:3,lsrc:10",
    CONNECTOR_TARGETS_WINDOWS: "windows",
    CONNECTOR_LEASE_SECONDS: "60",
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

const poll = (env, targets) => worker.fetch(req("https://link.v1d.io/api/link/connector/poll?source=wsl", {
  method: "POST", token: "wsl-token", body: { targets },
}), env);

const announce = (count) => Array.from({ length: count }, (_, index) => ({
  id: `skyvw:${index}`, label: `Skyvw pane ${index}`,
}));

async function seedSession(env) {
  const store = createLinkStore(env.LINK_DB);
  await store.insertSession({
    tokenHash: await sha256Hex(SESSION), identityId: "p-1", nowMs: NOW, ttlSeconds: 3600,
  });
  return store;
}

feature("the phone's target list comes from the fleet", () => {
  component("an announced list of N targets is served as N", {
    given: ["a worker whose seed names three targets", async () => {
      const env = makeEnv();
      await seedSession(env);
      return { env };
    }],
    when: ["the connector announces eleven panes and the app asks", async ({ env }) => {
      const before = await worker.fetch(req("https://link.v1d.io/api/link/targets", { token: SESSION }), env);
      const beforeBody = await before.json();
      await poll(env, announce(11));
      const after = await worker.fetch(req("https://link.v1d.io/api/link/targets", { token: SESSION }), env);
      const afterBody = await after.json();
      return { beforeBody, afterBody };
    }],
    then: ["the list grows by exactly what the fleet announced", (r) => {
      expect(r.beforeBody.targets).toHaveLength(3);
      // Three seeded plus eleven announced, none of them a seeded id.
      expect(r.afterBody.targets).toHaveLength(14);
      const announced = r.afterBody.targets.find((target) => target.id === "skyvw:2");
      expect(announced.label).toBe("Skyvw pane 2");
      expect(announced.online).toBe(true);
      // The operator's own wording still wins for a configured id.
      expect(r.afterBody.targets.find((target) => target.id === "lsrc:3").label).toBe("L-source 3");
    }],
  });

  component("a turn to an announced pane is accepted, claimed and replied", {
    given: ["a worker with one announced pane outside the seed", async () => {
      const env = makeEnv();
      await seedSession(env);
      await poll(env, announce(3));
      return { env };
    }],
    when: ["the app sends to it and the connector runs a cycle", async ({ env }) => {
      const clientMessageId = crypto.randomUUID();
      const sent = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", token: SESSION,
        body: { clientMessageId, target: "skyvw:2", kind: "text", text: "vad är klockan?" },
      }), env);
      const claimed = await (await poll(env, announce(3))).json();
      const acked = await worker.fetch(req("https://link.v1d.io/api/link/connector/ack", {
        method: "POST", token: "wsl-token", body: { clientMessageId, connectorId: "wsl-1" },
      }), env);
      const replied = await worker.fetch(req("https://link.v1d.io/api/link/connector/reply", {
        method: "POST", token: "wsl-token", body: { clientMessageId, connectorId: "wsl-1", body: "22:40" },
      }), env);
      return { sent, claimed, acked, replied };
    }],
    then: ["the whole journey works for a pane outside the seed", (r) => {
      expect(r.sent.status).toBe(201);
      expect(r.claimed.messages.map((message) => message.target)).toEqual(["skyvw:2"]);
      expect(r.acked.status).toBe(200);
      expect(r.replied.status).toBe(200);
    }],
  });

  component("observed and configured models stay qualified as the pane session changes", {
    given: ["a seeded target with current observed model evidence", async () => {
      const env = makeEnv();
      await seedSession(env);
      await poll(env, [{
        id: "lsrc:3",
        label: "connector wording must not win",
        model: {
          status: "current",
          observed: { model: "gpt-5.6-sol", effort: "xhigh" },
          configured: { model: "gpt-6-astra", effort: "max" },
        },
      }]);
      return { env };
    }],
    when: ["the connector later marks the same observation stale", async ({ env }) => {
      const before = await (await worker.fetch(
        req("https://link.v1d.io/api/link/targets", { token: SESSION }), env,
      )).json();
      await poll(env, [{
        id: "lsrc:3",
        label: "still ignored",
        model: {
          status: "stale",
          observed: { model: "gpt-5.6-sol", effort: "xhigh" },
          configured: { model: "gpt-6-astra", effort: "max" },
        },
      }]);
      const after = await (await worker.fetch(
        req("https://link.v1d.io/api/link/events?after=0", { token: SESSION }), env,
      )).json();
      return { before, after };
    }],
    then: ["both intent and observation reach the existing target feed without relabelling", ({ before, after }) => {
      const current = before.targets.find((target) => target.id === "lsrc:3");
      const stale = after.targets.find((target) => target.id === "lsrc:3");
      expect(current.label).toBe("L-source 3");
      expect(current.model).toEqual({
        status: "current",
        observed: { model: "gpt-5.6-sol", effort: "xhigh" },
        configured: { model: "gpt-6-astra", effort: "max" },
      });
      expect(stale.model.status).toBe("stale");
      expect(stale.model.observed.model).toBe("gpt-5.6-sol");
      expect(stale.model.configured.model).toBe("gpt-6-astra");
    }],
  });

  component("an announcement cannot invent a privileged kind or a bad address", {
    given: ["a worker and a session", async () => {
      const env = makeEnv();
      await seedSession(env);
      return { env };
    }],
    when: ["a connector announces a foreign kind and malformed ids", async ({ env }) => {
      await poll(env, [
        { id: "windows", label: "stolen" },
        { id: "not a target", label: "junk" },
        { id: "lsrc:3", label: "relabelled by the connector" },
        { id: "skyvw:2", label: "Skyvw pane 2" },
      ]);
      const listed = await (await worker.fetch(
        req("https://link.v1d.io/api/link/targets", { token: SESSION }), env,
      )).json();
      const foreign = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", token: SESSION,
        body: { clientMessageId: crypto.randomUUID(), target: "claw:3", kind: "text", text: "x" },
      }), env);
      return { listed, foreign };
    }],
    then: ["the seed still owns kinds, labels and the refusal", (r) => {
      expect(r.listed.targets.map((target) => target.id))
        .toEqual(["lsrc:3", "lsrc:10", "windows", "skyvw:2"]);
      expect(r.listed.targets.find((target) => target.id === "windows").kind).toBe("windows");
      expect(r.listed.targets.find((target) => target.id === "lsrc:3").label).toBe("L-source 3");
      expect(r.foreign.status).toBe(403);
    }],
  });

  component("a poll writes one beat, however many panes the connector reaches", {
    given: ["a worker and a session", async () => {
      const env = makeEnv();
      await seedSession(env);
      return { env };
    }],
    when: ["the connector polls twice, announcing eleven panes", async ({ env }) => {
      await poll(env, announce(11));
      await poll(env, announce(11));
      const beats = await env.LINK_DB.prepare(
        "SELECT connectorId, target FROM heartbeats",
      ).bind().all();
      const listed = await (await worker.fetch(
        req("https://link.v1d.io/api/link/targets", { token: SESSION }), env,
      )).json();
      return { rows: beats.results ?? beats, listed };
    }],
    then: ["one heartbeat row for the connector, and every target still reads online", (r) => {
      // Row 184's write budget: liveness is the connector's, not the pane's.
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]).toMatchObject({ connectorId: "wsl-1", target: "wsl-1" });
      expect(r.listed.targets.find((target) => target.id === "skyvw:7").online).toBe(true);
      // A seeded wsl target reads the same beat; windows has not polled at all.
      expect(r.listed.targets.find((target) => target.id === "lsrc:3").online).toBe(true);
      expect(r.listed.targets.find((target) => target.id === "windows").online).toBe(false);
    }],
  });

  component("only the fleet's own connector may announce panes", {
    given: ["a worker and a session", async () => {
      const env = makeEnv();
      await seedSession(env);
      return { env };
    }],
    when: ["the windows connector announces an agent pane", async ({ env }) => {
      const polled = await worker.fetch(req("https://link.v1d.io/api/link/connector/poll?source=windows", {
        method: "POST", token: "win-token", body: { targets: [{ id: "skyvw:2", label: "stolen" }] },
      }), env);
      const listed = await (await worker.fetch(
        req("https://link.v1d.io/api/link/targets", { token: SESSION }), env,
      )).json();
      const sent = await worker.fetch(req("https://link.v1d.io/api/link/send", {
        method: "POST", token: SESSION,
        body: { clientMessageId: crypto.randomUUID(), target: "skyvw:2", kind: "text", text: "x" },
      }), env);
      return { polled, listed, sent };
    }],
    then: ["its poll works, its announcement does not", (r) => {
      expect(r.polled.status).toBe(200);
      expect(r.listed.targets.map((target) => target.id)).toEqual(["lsrc:3", "lsrc:10", "windows"]);
      expect(r.sent.status).toBe(403);
    }],
  });

  component("a pane the fleet stopped announcing falls out of the list", {
    given: ["a worker with a short announce window", async () => {
      const env = makeEnv({ TARGET_ANNOUNCE_TTL_SECONDS: "60" });
      await seedSession(env);
      await poll(env, announce(2));
      return { env };
    }],
    when: ["the fleet announces without it, long after the window", async ({ env }) => {
      const store = createLinkStore(env.LINK_DB);
      // Age every announced row past the window, then announce the shorter list.
      await env.LINK_DB.prepare("UPDATE connector_targets SET seenAt = ?").bind(NOW - 3600_000).run();
      await poll(env, [{ id: "skyvw:0", label: "Skyvw pane 0" }]);
      const listed = await (await worker.fetch(
        req("https://link.v1d.io/api/link/targets", { token: SESSION }), env,
      )).json();
      const rows = await store.announcedTargets(0);
      return { listed, rows };
    }],
    then: ["the dropped pane leaves the list and the table", (r) => {
      expect(r.listed.targets.map((target) => target.id))
        .toEqual(["lsrc:3", "lsrc:10", "windows", "skyvw:0"]);
      expect(r.rows.map((row) => row.target)).toEqual(["skyvw:0"]);
    }],
  });
});
