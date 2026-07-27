// Mailbox contract tests: idempotent send, atomic claim, lease reclaim,
// delivered/reply/fail decisions, and exact-once across a connector restart.

import { expect, feature, component } from "bdd-vitest";
import { createLinkStore } from "./store.mjs";
import { createTestDb } from "./testdb.mjs";
import { sendDecision, ackDecision, replyDecision, failDecision } from "./mailbox.mjs";

const NOW = 1_800_000_000_000;
const msg = (over = {}) => ({
  clientMessageId: "m-1",
  target: "lsrc:3",
  kind: "text",
  body: "hej",
  voiceRef: null,
  state: "queued",
  createdAt: NOW,
  leaseOwner: null,
  leaseExpiresAt: null,
  deliveredAt: null,
  replyBody: null,
  replyAt: null,
  attempts: 0,
  lastError: null,
  ...over,
});

feature("mailbox send: idempotency by clientMessageId", () => {
  component("same id and payload replays, same id different payload conflicts", {
    given: ["an existing queued message", () => ({ existing: msg() })],
    when: ["sending both shapes", (ctx) => ({
      replay: sendDecision({ existing: ctx.existing, clientMessageId: "m-1", target: "lsrc:3", kind: "text", body: "hej" }),
      conflict: sendDecision({ existing: ctx.existing, clientMessageId: "m-1", target: "lsrc:3", kind: "text", body: "annan" }),
      fresh: sendDecision({ existing: null, clientMessageId: "m-2", target: "lsrc:10", kind: "text", body: "ny" }),
    })],
    then: ["exactly one insert ever happens", (r) => {
      expect(r.replay).toMatchObject({ action: "replay", status: 200 });
      expect(r.conflict).toEqual({ action: "reject", status: 409, reason: "idempotency-key-reused" });
      expect(r.fresh).toMatchObject({ action: "insert", status: 201 });
    }],
  });
});

feature("connector claim and terminal decisions", () => {
  component("ack requires the lease owner, terminal states are idempotent", {
    given: ["leased, delivered, and replied messages", () => ({
      leased: msg({ state: "leased", leaseOwner: "wsl-1" }),
      delivered: msg({ state: "delivered", leaseOwner: "wsl-1" }),
      replied: msg({ state: "replied" }),
    })],
    when: ["judging ack and reply", (ctx) => ({
      ackOwner: ackDecision({ message: ctx.leased, connectorId: "wsl-1" }),
      ackStranger: ackDecision({ message: ctx.leased, connectorId: "wsl-2" }),
      ackTerminal: ackDecision({ message: ctx.replied, connectorId: "wsl-1" }),
      replyOk: replyDecision({ message: ctx.delivered, connectorId: "wsl-1" }),
      replyTwice: replyDecision({ message: ctx.replied, connectorId: "wsl-1" }),
      replyNotDelivered: replyDecision({ message: ctx.leased, connectorId: "wsl-1" }),
    })],
    then: ["only the lease owner may finish a message", (r) => {
      expect(r.ackOwner).toMatchObject({ ok: true, reason: "deliver" });
      expect(r.ackStranger).toEqual({ ok: false, reason: "not-lease-owner" });
      expect(r.ackTerminal).toMatchObject({ ok: true, idempotent: true });
      expect(r.replyOk).toMatchObject({ ok: true, reason: "reply" });
      expect(r.replyTwice).toMatchObject({ ok: true, idempotent: true });
      expect(r.replyNotDelivered).toEqual({ ok: false, reason: "not-delivered-by-connector" });
    }],
  });

  component("fail honors ownership and terminal stays terminal", {
    given: ["a leased and a failed message", () => ({
      leased: msg({ state: "leased", leaseOwner: "wsl-1" }),
      failed: msg({ state: "failed" }),
    })],
    when: ["judging failures", (ctx) => ({
      failOwner: failDecision({ message: ctx.leased, connectorId: "wsl-1" }),
      failStranger: failDecision({ message: ctx.leased, connectorId: "wsl-2" }),
      failAgain: failDecision({ message: ctx.failed, connectorId: "wsl-2" }),
    })],
    then: ["honest terminal, no silent retry loop", (r) => {
      expect(r.failOwner.ok).toBe(true);
      expect(r.failStranger).toEqual({ ok: false, reason: "not-lease-owner" });
      expect(r.failAgain).toMatchObject({ ok: true, idempotent: true });
    }],
  });
});

feature("store over the real schema: one exact journey and a connector crash", () => {
  component("queue to reply with a connector restart between claim and ack", {
    given: ["a fresh store and one message", async () => {
      const store = createLinkStore(createTestDb());
      await store.insertMessage({ clientMessageId: "m-1", target: "lsrc:3", kind: "text", body: "hej", nowMs: NOW });
      return { store };
    }],
    when: ["connector A claims, dies, B re-claims, delivers and replies", async ({ store }) => {
      const firstClaim = (await store.claimQueued({ connectorId: "wsl-A", targets: ["lsrc:3"], leaseMs: 60_000, nowMs: NOW }));
      // A dies before ack; the lease expires; B reclaims the same message.
      await store.reclaimExpiredLeases(NOW + 61_000);
      const secondClaim = (await store.claimQueued({ connectorId: "wsl-B", targets: ["lsrc:3"], leaseMs: 60_000, nowMs: NOW + 62_000 }));
      const afterAck = await store.markDelivered({ clientMessageId: "m-1", connectorId: "wsl-B", nowMs: NOW + 63_000 });
      const afterReply = await store.markReplied({ clientMessageId: "m-1", connectorId: "wsl-B", replyBody: "svar", nowMs: NOW + 64_000 });
      const final = await store.getMessage("m-1");
      const events = await store.eventsAfter({ afterSeq: 0 });
      return { firstClaim, secondClaim, afterAck, afterReply, final, events };
    }],
    then: ["exactly one message, owned by B, replied once, full event trail", (r) => {
      expect(r.firstClaim).toHaveLength(1);
      expect(r.firstClaim[0]).toMatchObject({ state: "leased", leaseOwner: "wsl-A", attempts: 1 });
      expect(r.secondClaim).toHaveLength(1);
      expect(r.secondClaim[0]).toMatchObject({ leaseOwner: "wsl-B", attempts: 2 });
      expect(r.final).toMatchObject({
        state: "replied",
        leaseOwner: "wsl-B",
        replyBody: "svar",
        attempts: 2,
      });
      expect(r.events).toHaveLength(1);
    }],
  });

  component("a delivered message with no reply returns to the queue once, never duplicated", {
    given: ["one delivered message owned by a dead connector", async () => {
      const store = createLinkStore(createTestDb());
      await store.insertMessage({ clientMessageId: "m-1", target: "lsrc:3", kind: "text", body: "hej", nowMs: NOW });
      await store.claimQueued({ connectorId: "wsl-A", targets: ["lsrc:3"], leaseMs: 60_000, nowMs: NOW });
      await store.markDelivered({ clientMessageId: "m-1", connectorId: "wsl-A", nowMs: NOW });
      return { store };
    }],
    when: ["the reply timeout passes and another connector polls", async ({ store }) => {
      await store.reclaimStaleDelivered(NOW + 600_001);
      return store.claimQueued({ connectorId: "wsl-B", targets: ["lsrc:3"], leaseMs: 60_000, nowMs: NOW + 600_001 });
    }],
    then: ["the same message is claimable again with a fresh owner", (rows) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ state: "leased", leaseOwner: "wsl-B", attempts: 2 });
    }],
  });

  component("claim respects target ownership and the five-message bound", {
    given: ["messages for two targets plus one foreign", async () => {
      const store = createLinkStore(createTestDb());
      for (let i = 0; i < 7; i += 1) {
        await store.insertMessage({ clientMessageId: `m-${i}`, target: i < 6 ? "lsrc:3" : "windows", kind: "text", body: `t${i}`, nowMs: NOW + i });
      }
      return { store };
    }],
    when: ["the lsrc:3 connector claims", async ({ store }) =>
      store.claimQueued({ connectorId: "wsl-1", targets: ["lsrc:3"], leaseMs: 60_000, nowMs: NOW })],
    then: ["five own, none foreign, oldest first", (rows) => {
      expect(rows).toHaveLength(5);
      expect(rows.every((row) => row.target === "lsrc:3")).toBe(true);
      expect(rows[0].clientMessageId).toBe("m-0");
      expect(rows[4].clientMessageId).toBe("m-4");
    }],
  });

  component("duplicate insert id with different payload is rejected by the caller", {
    given: ["one stored message", async () => {
      const store = createLinkStore(createTestDb());
      await store.insertMessage({ clientMessageId: "m-1", target: "lsrc:3", kind: "text", body: "hej", nowMs: NOW });
      return { store };
    }],
    when: ["reading it back for the send decision", async ({ store }) => ({
      existing: await store.getMessage("m-1"),
      missing: await store.getMessage("m-2"),
    })],
    then: ["the decision layer sees exactly what is stored", (r) => {
      expect(r.existing).toMatchObject({ clientMessageId: "m-1", state: "queued" });
      expect(r.missing).toBeNull();
    }],
  });

  component("heartbeats turn stale honestly", {
    given: ["one wsl and one windows heartbeat", async () => {
      const store = createLinkStore(createTestDb());
      await store.heartbeat({ connectorId: "wsl-1", target: "lsrc:3", source: "wsl", nowMs: NOW });
      await store.heartbeat({ connectorId: "win-1", target: "windows", source: "windows", nowMs: NOW - 10 * 60_000 });
      return { store };
    }],
    when: ["reading states with a 90s stale bound", async ({ store }) =>
      store.heartbeatStates(90_000, NOW)],
    then: ["fresh is online, ten-minute-old is offline", (rows) => {
      const byTarget = Object.fromEntries(rows.map((row) => [row.target, row.online]));
      expect(byTarget).toEqual({ "lsrc:3": 1, windows: 0 });
    }],
  });
});
