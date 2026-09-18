// Row 187: a message the mailbox hands out for ever has no honest state to show.
// Measured on production 2026-09-18: Mattias's "hej" to lsrc:3 sat at 377
// attempts over nine hours, re-claimed on every lease expiry, while the app
// showed it pending. After the declared number of attempts the mailbox calls it
// unanswered and names why.

import { expect, feature, component } from "bdd-vitest";
import worker from "./index.mjs";
import { createTestDb } from "./testdb.mjs";
import { createLinkStore } from "./store.mjs";

const NOW = Date.now();
const ID = "5f7026ca-8141-48fa-ae54-26d44da392c1";

function makeEnv(overrides = {}) {
  return {
    LINK_DB: createTestDb(),
    LINK_AUTH_ORIGIN: "https://identity.example.com",
    LINK_AUTH_APP_ID: "agentmux-link",
    LINK_AUTH_CLIENT_SECRET: "client-secret",
    LINK_AUTH_STATE_SECRET: "ab".repeat(32),
    LINK_AUTH_CALLBACK_URL: "https://link.example.com/auth/callback",
    CONNECTOR_TOKEN_WSL: "wsl-token",
    CONNECTOR_TOKEN_WINDOWS: "win-token",
    LINK_TARGETS: "lsrc:3|L-source 3",
    CONNECTOR_TARGETS_WSL: "lsrc:3",
    CONNECTOR_TARGETS_WINDOWS: "windows",
    CONNECTOR_LEASE_SECONDS: "60",
    MAX_DELIVERY_ATTEMPTS: "3",
    MAX_TEXT_CHARS: "4000",
    ...overrides,
  };
}

const poll = (env) => worker.fetch(new Request("https://link.v1d.io/api/link/connector/poll?source=wsl", {
  method: "POST",
  headers: { authorization: "Bearer wsl-token", "content-type": "application/json" },
  body: "{}",
}), env);

async function seed(env, { attempts = 0, state = "queued" } = {}) {
  const store = createLinkStore(env.LINK_DB);
  await store.insertMessage({
    clientMessageId: ID, identityId: "p-1", target: "lsrc:3", kind: "text", body: "hej", nowMs: NOW,
  });
  await env.LINK_DB.prepare("UPDATE messages SET attempts = ?, state = ? WHERE clientMessageId = ?")
    .bind(attempts, state, ID).run();
  return store;
}

/** What a connector that never finishes the turn leaves behind: an expired lease. */
const expireLease = (env) =>
  env.LINK_DB.prepare("UPDATE messages SET leaseExpiresAt = 1 WHERE clientMessageId = ?").bind(ID).run();

feature("a turn nobody can finish stops being pending", () => {
  component("the mailbox fails it after the declared number of attempts", {
    given: ["a message and a connector that claims but never acks", () => makeEnv()],
    when: ["polling until the cap is passed", async (env) => {
      const store = await seed(env);
      const claims = [];
      for (let i = 0; i < 4; i++) {
        const response = await poll(env);
        claims.push((await response.json()).messages.length);
        await expireLease(env);
      }
      return { row: await store.getMessage(ID), claims };
    }],
    then: ["three claims, then failed with the reason in the row", (r) => {
      expect(r.claims).toEqual([1, 1, 1, 0]);
      expect(r.row.state).toBe("failed");
      expect(r.row.attempts).toBe(3);
      expect(r.row.lastError).toBe("no-reply-after-3-attempts");
      // replyAt is what the app reads as "this is over"; a failed turn has one.
      expect(r.row.replyAt).toBeGreaterThan(0);
    }],
  });

  component("a message under the cap keeps its place in the queue", {
    given: ["a message one attempt short of the cap", () => makeEnv()],
    when: ["one poll", async (env) => {
      const store = await seed(env, { attempts: 1 });
      const response = await poll(env);
      return { claimed: (await response.json()).messages.length, row: await store.getMessage(ID) };
    }],
    then: ["it is claimed again, not failed", (r) => {
      expect(r.claimed).toBe(1);
      expect(r.row.state).toBe("leased");
      expect(r.row.attempts).toBe(2);
    }],
  });

  component("a turn a connector is holding right now is never failed under it", {
    given: ["a leased message already past the cap", () => makeEnv()],
    when: ["a poll runs while its lease is still live", async (env) => {
      const store = await seed(env, { attempts: 9, state: "leased" });
      await env.LINK_DB.prepare("UPDATE messages SET leaseOwner = 'wsl-1', leaseExpiresAt = ? WHERE clientMessageId = ?")
        .bind(Date.now() + 60_000, ID).run();
      await poll(env);
      return await store.getMessage(ID);
    }],
    then: ["it stays leased, because the pane may still answer", (row) => {
      expect(row.state).toBe("leased");
      expect(row.lastError).toBeNull();
    }],
  });
});
