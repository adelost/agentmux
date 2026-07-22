import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { createAudioOutbox } from "./audio-outbox.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "audio-outbox-test-"));
  const journalPath = join(root, "outbox.jsonl");
  let clock = Date.parse("2026-07-20T15:00:00.000Z");
  let sequence = 0;
  const options = {
    journalPath,
    now: () => new Date(clock),
    id: () => `evt-${++sequence}`,
  };
  return {
    root,
    outbox: createAudioOutbox(options),
    restart: () => createAudioOutbox(options),
    advance: (ms) => { clock += ms; },
  };
}

feature("durable explicit-audio outbox", () => {
  component("one publish survives restart and replay is bounded by event identity", {
    given: ["an empty versioned journal", () => fixture()],
    when: ["one explicit event is published and the bridge-facing reader restarts", (fx) => {
      const first = fx.outbox.publish({ text: " Hej ", target: "channel-1" });
      const duplicate = fx.outbox.publish({
        text: "different retry body",
        target: "channel-1",
        eventId: first.event.eventId,
      });
      const replay = fx.restart().listPending({ consumerId: "phone-1", target: "channel-1" });
      return { fx, first, duplicate, replay };
    }],
    then: ["the same eventId appears once with its durable envelope", ({ fx, first, duplicate, replay }) => {
      expect(first.duplicate).toBe(false);
      expect(duplicate.duplicate).toBe(true);
      expect(replay).toHaveLength(1);
      expect(replay[0]).toEqual(first.event);
      expect(replay[0]).toMatchObject({
        schemaVersion: 1,
        text: "Hej",
        target: { type: "discord-channel", id: "channel-1" },
      });
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  component("receiving is distinct from played and ambiguous starts never replay", {
    given: ["one pending event", () => {
      const fx = fixture();
      const event = fx.outbox.publish({ text: "Kort status", target: "channel-1" }).event;
      return { fx, event };
    }],
    when: ["a phone receives, queues and reserves playback before restart", ({ fx, event }) => {
      fx.outbox.receipt({ eventId: event.eventId, consumerId: "phone-1", state: "received" });
      expect(fx.restart().listPending({ consumerId: "phone-1", target: "channel-1" }))
        .toHaveLength(1);
      fx.outbox.receipt({ eventId: event.eventId, consumerId: "phone-1", state: "queued" });
      fx.outbox.receipt({ eventId: event.eventId, consumerId: "phone-1", state: "playback-started" });
      return {
        fx,
        event,
        replay: fx.restart().listPending({ consumerId: "phone-1", target: "channel-1" }),
      };
    }],
    then: ["the reserved event is not replayed and played remains a separate receipt", ({ fx, event, replay }) => {
      expect(replay).toEqual([]);
      const played = fx.restart().receipt({
        eventId: event.eventId,
        consumerId: "phone-1",
        state: "played",
      });
      expect(played.receipt.state).toBe("played");
      expect(fx.outbox.receiptsFor({ eventId: event.eventId, consumerId: "phone-1" })
        .map((entry) => entry.state))
        .toEqual(["received", "queued", "playback-started", "played"]);
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  component("expired items and other targets are never offered", {
    given: ["events for two targets", () => {
      const fx = fixture();
      fx.outbox.publish({ text: "old", target: "channel-1", ttlMs: 1000 });
      fx.outbox.publish({ text: "other", target: "channel-2" });
      fx.advance(1001);
      return fx;
    }],
    when: ["the phone asks for its current target", (fx) => ({
      fx,
      replay: fx.outbox.listPending({ consumerId: "phone-1", target: "channel-1" }),
    })],
    then: ["nothing stale or cross-target leaks", ({ fx, replay }) => {
      expect(replay).toEqual([]);
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  component("receipt transitions are idempotent but cannot skip to played", {
    given: ["one pending event", () => {
      const fx = fixture();
      const event = fx.outbox.publish({ text: "Hej", target: "channel-1" }).event;
      return { fx, event };
    }],
    when: ["the phone retries received and then attempts an impossible played receipt", ({ fx, event }) => {
      const first = fx.outbox.receipt({
        eventId: event.eventId,
        consumerId: "phone-1",
        state: "received",
      });
      const second = fx.outbox.receipt({
        eventId: event.eventId,
        consumerId: "phone-1",
        state: "received",
      });
      let error;
      try {
        fx.outbox.receipt({ eventId: event.eventId, consumerId: "phone-1", state: "played" });
      } catch (caught) {
        error = caught;
      }
      return { fx, first, second, error };
    }],
    then: ["only one received row exists and played was rejected", ({ fx, first, second, error }) => {
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(error.message).toContain("received -> played");
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });
});
