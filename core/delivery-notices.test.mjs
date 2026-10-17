import { expect, feature, unit, component } from "bdd-vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { blockedDeliveryNotice, createDiscordDeliveryNotify, deliveryStateNotice } from "./delivery-notices.mjs";
import { NOTICE_BANNED_WORDS } from "./delivery-notice-copy.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";

const UTC = { timeZone: "UTC" };
const T = Date.UTC(2026, 8, 23, 15, 54);

/** A Discord double that records posts, replies and edits with stable ids. */
const recordingDiscord = () => {
  const posts = [];
  const edits = [];
  let next = 0;
  return {
    posts, edits,
    sent: posts,
    send: async (channelId, text) => { const id = `n${++next}`; posts.push({ channelId, text, id }); return { id }; },
    replyTo: async (channelId, replyTo, text) => {
      const id = `n${++next}`; posts.push({ channelId, text, id, replyTo }); return { id };
    },
    editMessage: async (channelId, messageId, text) => { edits.push({ channelId, messageId, text }); },
  };
};

const humanJob = (overrides = {}) => ({
  agentName: "lsrc", pane: 3, source: "discord", createdAt: T - 12 * 60_000,
  verifyText: "Komihåg att fixa skyvw\n[image attached: /x/1.jpg]",
  metadata: { channelId: "c3", messageId: "d1" }, ...overrides,
});

const MODEL_GUARD = "Codex work blocked: selected gpt-5.6-sol, running gpt-6-sol; verify /status before retrying";

feature("delivery notices a human understands", () => {
  unit("waiting names the panel and the real reason in everyday words", {
    when: ["rendering the lsrc:3 model-guard wait", () => deliveryStateNotice(humanJob({ lastReason: MODEL_GUARD }), "blocked", UTC)],
    then: ["one sentence per part, no machinery", (text) => expect(text).toBe(
      "lsrc:3 has not got this yet. Cause: the pane runs gpt-6-sol but is set to gpt-5.6-sol. "
      + "It is sent automatically when it can be.")],
  });

  unit("each known blocker is translated and an unknown one is shown as it is", {
    then: ["memory, identity, context cost and raw reasons", () => {
      expect(blockedDeliveryNotice({ agentName: "a", pane: 1, lastReason: "wake-refused:memory-critical" }))
        .toContain("Cause: the computer is low on memory right now.");
      expect(blockedDeliveryNotice({ agentName: "a", pane: 1, lastReason: "wake-refused:identity-package-content" }))
        .toContain("Cause: the amux installation cannot be verified.");
      expect(blockedDeliveryNotice({ agentName: "a", pane: 1, lastReason: "wake-refused:context-cost:unknown-evidence" }))
        .toContain("Cause: the pane is large and has waited long, so it is compacted first.");
      expect(blockedDeliveryNotice({ agentName: "a", pane: 1, lastReason: "probe unavailable" }))
        .toContain("Cause: probe unavailable.");
      expect(blockedDeliveryNotice({ agentName: "a", pane: 1, lastReason: "prompt has not reached authoritative JSONL yet" }))
        .toContain("Cause: the pane has not confirmed that it got it.");
    }],
  });

  unit("delivered replaces waiting with the time and how long it took", {
    when: ["rendering an acknowledgement 12 minutes after the message", () =>
      deliveryStateNotice(humanJob({ acknowledgedAt: T }), "recovered", UTC)],
    then: ["the outcome reads as one line", (text) =>
      expect(text).toBe("lsrc:3 got this at 15:54, after 12 minutes.")],
  });

  unit("a single removal says who removed it and why", {
    when: ["rendering one sender cancellation", () => deliveryStateNotice(humanJob({
      cancelRequestedBy: "lsrc:0", cancelRequestedReason: "uppfyllt av lsrc:0",
      metadata: { channelId: "c3", messageId: "d1", deliveryOutcome: "not-sent", deliveryCancellation: "sender-request" },
    }), "not-sent")],
    then: ["the actor and the quoted reason are named", (text) =>
      expect(text).toBe("Not sent to lsrc:3. lsrc:0 removed it: “uppfyllt av lsrc:0”.")],
  });

  unit("a give-up names attempts, time and what to do", {
    when: ["rendering a pre-submit timeout", () => deliveryStateNotice(humanJob({
      attempts: 64, firstAttemptAt: T - 60 * 60_000, terminalAt: T, lastReason: MODEL_GUARD,
      metadata: { deliveryOutcome: "not-sent", deliveryTimeout: "pre-submit" },
    }), "not-sent")],
    then: ["the reader knows when to resend", (text) => expect(text).toBe(
      "Not sent to lsrc:3 after 64 attempts in 1 h. Cause: the pane runs gpt-6-sol but is set to gpt-5.6-sol. "
      + "Send it again once that is fixed.")],
  });

  unit("an unconfirmed send explains why it is not resent", {
    when: ["rendering an unverified outcome", () => deliveryStateNotice(humanJob(), "unverified")],
    then: ["no promise, no duplicate", (text) => expect(text).toBe(
      "lsrc:3 may have got this, but amux cannot confirm it. It is not sent again, so it is not doubled. See the reply above.")],
  });

  const reasons = [MODEL_GUARD, "Codex work blocked: compact not verified", "wake-refused:memory-blocked",
        "wake-refused:guard-state-stale", "wake-refused:identity-x", "wake-refused:context-cost:unknown-evidence",
        "Codex prompt delivery blocked: composer is not empty (starts with: hej)",
        "provisional paste differs from composer; preserving both (x)",
        "Prompt delivery blocked: durable draft is not visible; refusing to paste it again",
        "awaiting exact JSONL receipt; TUI hint: hidden", "prompt has not reached authoritative JSONL yet",
        "submit fence committed before physical completion; awaiting authoritative receipt"];
  // Each reason keeps the original full matrix within the unit-test time budget.
  for (const lastReason of reasons) {
  unit(`no notice uses an internal word for ${lastReason}`, {
    then: ["every template and metadata case remains free of machinery", () => {
      const texts = [];
        for (const metadata of [{ deliveryCancellation: "sender-request" }, { deliveryRejection: "engine-rejected" },
          { deliveryTarget: "not-ingesting" }, { deliveryTimeout: "pre-submit" }, { deliveryAmbiguity: "submitting-fence" }]) {
          const job = humanJob({ lastReason, cancelRequestedBy: "delivery-broker", acknowledgedAt: T, attempts: 3,
            metadata: { ...metadata, deliveryOutcome: "not-sent" } });
          for (const state of ["blocked", "stalled", "recovered", "not-sent", "unverified"]) {
            texts.push(deliveryStateNotice(job, state, { queuedBehind: 2, waitedMs: 3 * 3_600_000, ...UTC }));
          }
          texts.push(deliveryStateNotice(job, "not-sent-group", { jobs: [job, job], ...UTC }));
        }
      for (const text of texts) {
        for (const word of NOTICE_BANNED_WORDS) expect(text.toLowerCase()).not.toContain(word);
      }
    }],
  });
  }

  unit("a notice for a pane without a bound channel fails so the broker retries it", {
    given: ["a Discord adapter and no channel for the pane", () => recordingDiscord()],
    when: ["notifying a blocked job", (discord) => createDiscordDeliveryNotify({
      discord, resolveChannel: () => null,
    })({ agentName: "lsrc", pane: 3, source: "discord", lastReason: "memory-blocked" }, "blocked")
      .then(() => null, (error) => ({ error, discord }))],
    then: ["nothing is posted and the failure names the pane", (result) => {
      expect(result.error.message).toContain("lsrc:3");
      expect(result.discord.posts).toEqual([]);
    }],
  });

  unit("a notice replies to the human message it concerns", {
    given: ["a Discord adapter", () => recordingDiscord()],
    when: ["notifying a blocked Discord message", async (discord) => {
      const ref = await createDiscordDeliveryNotify({ discord, resolveChannel: () => "looked-up", ...UTC })(
        humanJob({ lastReason: MODEL_GUARD }), "blocked");
      return { discord, ref };
    }],
    then: ["the reply lands on the original in its recorded channel", ({ discord, ref }) => {
      expect(discord.posts).toEqual([expect.objectContaining({ channelId: "c3", replyTo: "d1" })]);
      expect(ref).toMatchObject({ channelId: "c3", messageId: "n1" });
    }],
  });

  unit("without an original message the notice quotes its first words", {
    given: ["a Discord adapter", () => recordingDiscord()],
    when: ["notifying a terminal message typed by the operator in a shell", async (discord) => {
      await createDiscordDeliveryNotify({ discord, resolveChannel: () => "c3" })(
        { agentName: "lsrc", pane: 3, source: "cli", verifyText: "Kör om testerna på skyvw och rapportera",
          metadata: {}, lastReason: MODEL_GUARD }, "blocked");
      return discord;
    }],
    then: ["the quote identifies the message", (discord) =>
      expect(discord.posts[0].text).toMatch(/\n> Kör om testerna på skyvw och rapportera$/u)],
  });

  unit("an agent's message never raises a notice in the human channel", {
    given: ["a Discord adapter", () => recordingDiscord()],
    when: ["notifying every state for a message lsrc:0 sent to lsrc:3", async (discord) => {
      const notify = createDiscordDeliveryNotify({ discord, resolveChannel: () => "c3" });
      const job = { agentName: "lsrc", pane: 3, source: "cli", verifyText: "[from lsrc:0] brief",
        metadata: { sender: "lsrc:0", channelId: "c3" }, lastReason: MODEL_GUARD };
      for (const state of ["blocked", "stalled", "recovered", "not-sent", "unverified"]) await notify(job, state);
      return discord;
    }],
    then: ["the human channel stays quiet", (discord) => {
      expect(discord.posts).toEqual([]);
      expect(discord.edits).toEqual([]);
    }],
  });
});

const tempRoot = () => join(tmpdir(), `amux-notice-ux-${process.pid}-${Math.random().toString(36).slice(2)}`);

function refusingAgent() {
  const echoed = new Set();
  let refuse = true;
  return {
    heal: () => { refuse = false; },
    capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
    waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
    dismissBlockingPrompt: async () => null,
    sendOnly: async (_name, text, _pane, options = {}) => {
      if (refuse) {
        const error = new Error(MODEL_GUARD);
        error.code = "AMUX_DELIVERY_REFUSED";
        throw error;
      }
      await options.onPasteStarted?.(); await options.onDrafted?.();
      await options.onSubmitting?.(); await options.onSubmitted?.();
      echoed.add(text);
      return { submitted: true, queued: false };
    },
  };
}

function brokerWorld(agent = refusingAgent()) {
  const rootDir = tempRoot();
  mkdirSync(rootDir, { recursive: true });
  let clock = T;
  const queue = createDeliveryQueue({ rootDir, now: () => clock });
  const discord = recordingDiscord();
  const broker = createDeliveryBroker({ agent, queue, now: () => clock,
    notify: createDiscordDeliveryNotify({ discord, resolveChannel: () => "c3", ...UTC }) });
  return { rootDir, queue, discord, broker, agent, advance: (ms) => { clock += ms; },
    cleanup: () => rmSync(rootDir, { recursive: true, force: true }) };
}

feature("delivery notices keep one notice per event", () => {
  component("fourteen cancellations within a minute become one notice", {
    given: ["fourteen queued Discord messages to lsrc:3, each cancelled by lsrc:0", () => {
      const world = brokerWorld();
      for (let i = 0; i < 14; i++) {
        const job = world.queue.enqueue({ agentName: "lsrc", pane: 3, source: "discord",
          text: `Meddelande nummer ${i + 1}`, createdAt: T - (14 - i) * 60_000,
          metadata: { channelId: "c3", messageId: `d${i}` } });
        world.queue.requestCancellation(job.id, { requestedBy: "lsrc:0", reason: "uppfyllt" });
      }
      return world;
    }],
    when: ["the broker handles the cancellations over the next minute", async (world) => {
      await world.broker.kickTarget("lsrc", 3);
      world.advance(10_000);
      await world.broker.kickTarget("lsrc", 3);
      world.advance(40_000);
      await world.broker.kickTarget("lsrc", 3);
      world.advance(60_000);
      await world.broker.kickTarget("lsrc", 3);
      return world.discord.posts;
    }],
    then: ["exactly one list notice is posted", (posts, world) => {
      expect(posts).toHaveLength(1);
      const lines = posts[0].text.split("\n");
      expect(lines[0]).toBe("14 messages to lsrc:3 were not sent. lsrc:0 removed them: “uppfyllt”.");
      expect(lines[1]).toBe("• 15:40 Meddelande nummer 1");
      expect(lines).toHaveLength(12);
      expect(lines[11]).toBe("+4 more");
      world.cleanup();
    }],
  });

  component("one cancellation keeps its own reply", {
    given: ["one cancelled Discord message", () => {
      const world = brokerWorld();
      const job = world.queue.enqueue({ agentName: "lsrc", pane: 3, source: "discord", text: "Finputsa sen",
        metadata: { channelId: "c3", messageId: "d9" } });
      world.queue.requestCancellation(job.id, { requestedBy: "lsrc:0", reason: "uppfyllt" });
      return world;
    }],
    when: ["the cancellation settles", async (world) => {
      await world.broker.kickTarget("lsrc", 3);
      world.advance(40_000);
      await world.broker.kickTarget("lsrc", 3);
      return world.discord.posts;
    }],
    then: ["a single reply on the original message", (posts, world) => {
      expect(posts).toEqual([expect.objectContaining({ replyTo: "d9",
        text: "Not sent to lsrc:3. lsrc:0 removed it: “uppfyllt”." })]);
      world.cleanup();
    }],
  });

  component("waiting then delivered edits the same notice", {
    given: ["a Discord message the model guard refuses at first", () => {
      const world = brokerWorld();
      world.job = world.queue.enqueue({ agentName: "lsrc", pane: 3, source: "discord", text: "Komihåg att fixa skyvw",
        metadata: { channelId: "c3", messageId: "d1" } });
      return world;
    }],
    when: ["the wait passes one minute and the guard later admits it", async (world) => {
      await world.broker.kickTarget("lsrc", 3);
      world.advance(61_000);
      await world.broker.kickTarget("lsrc", 3);
      world.agent.heal();
      world.advance(12 * 60_000);
      await world.broker.kickTarget("lsrc", 3);
      return world;
    }],
    then: ["one reply, then one edit of that reply", (world) => {
      expect(world.discord.posts).toHaveLength(1);
      expect(world.discord.posts[0]).toMatchObject({ replyTo: "d1" });
      expect(world.discord.posts[0].text).toContain("lsrc:3 has not got this yet");
      expect(world.discord.edits).toEqual([{ channelId: "c3", messageId: world.discord.posts[0].id,
        text: "lsrc:3 got this at 16:07, after 13 minutes." }]);
      world.cleanup();
    }],
  });

  component("an agent's cancelled message reaches no human channel", {
    given: ["lsrc:0's own message to lsrc:3, cancelled by lsrc:0", () => {
      const world = brokerWorld();
      const job = world.queue.enqueue({ agentName: "lsrc", pane: 3, source: "cli", text: "[from lsrc:0] brief",
        metadata: { sender: "lsrc:0", channelId: "c3" } });
      world.queue.requestCancellation(job.id, { requestedBy: "lsrc:0", reason: "handled myself" });
      return world;
    }],
    when: ["the cancellation settles", async (world) => {
      await world.broker.kickTarget("lsrc", 3);
      world.advance(3 * 60_000);
      await world.broker.kickTarget("lsrc", 3);
      return world;
    }],
    then: ["no Discord post and no message back to the sender who cancelled", (world) => {
      expect(world.discord.posts).toEqual([]);
      expect(world.queue.list("lsrc", 0)).toEqual([]);
      world.cleanup();
    }],
  });
});
