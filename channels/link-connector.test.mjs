// Link connector cycle: journal-before-ack, restart safety, honest failure.

import { expect, feature, component } from "bdd-vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  connectorFailureDisposition,
  connectorFailureStage,
  linkTurnPrompt,
  planClaimedMessage,
  runLinkConnectorCycle,
  waitForLinkReply,
} from "./link-connector.mjs";

const NOW = Date.now();

/** Row 186: the cycle hands each reply wait off and returns. A test that wants
 *  the reply posted joins the waits that cycle started. */
async function cycleWithReplies(deps) {
  const result = await runLinkConnectorCycle(deps);
  await Promise.all(result.started ?? []);
  return result;
}
const message = (over = {}) => ({
  clientMessageId: "m-1",
  target: "lsrc:3",
  kind: "text",
  body: "hej från telefonen",
  ...over,
});

function harness({ responses = {}, replyText = "svar från pane" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-link-conn-"));
  const statePath = join(root, "connector.json");
  const calls = { posts: [], enqueued: [] };
  // What the worker recorded, keyed by message. A poll hands the row back as the
  // mailbox has it, so a second cycle sees the ack and the reply that the first
  // one posted. A stateless mailbox would keep saying "never delivered", and the
  // connector's repair of exactly that state (row 187) would read as a bug.
  const mailbox = new Map();
  const recorded = (clientMessageId, patch) => {
    const id = String(clientMessageId || "");
    if (id) mailbox.set(id, { ...mailbox.get(id), ...patch });
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body || "{}");
    calls.posts.push({ url, body });
    const route = url.replace("https://link.v1d.io", "");
    if (route.includes("/connector/ack")) recorded(body.clientMessageId, { state: "delivered", deliveredAt: NOW });
    if (route.includes("/connector/reply")) recorded(body.clientMessageId, { state: "replied", replyAt: NOW, replyBody: body.body });
    if (route.includes("/connector/fail")) recorded(body.clientMessageId, { state: "failed", lastError: body.error });
    const payload = responses[route] ?? (route.startsWith("/api/link/connector/poll") ? { messages: [] } : {});
    if (payload instanceof Error) throw payload;
    const answered = route.startsWith("/api/link/connector/poll")
      ? { ...payload, messages: (payload.messages || []).map((m) => ({ ...m, ...mailbox.get(String(m.clientMessageId)) })) }
      : payload;
    const voice = Buffer.from("FAKE-VOICE-BYTES");
    const voiceBytes = voice.buffer.slice(voice.byteOffset, voice.byteOffset + voice.byteLength);
    return { ok: true, json: async () => answered, arrayBuffer: async () => voiceBytes };
  };
  const agent = {
    hasResponseForPrompt: () => true,
    getResponseStreamWithRaw: async () => ({ items: [{ type: "text", content: replyText }] }),
  };
  const deliveryBroker = {
    enqueue: (job) => { calls.enqueued.push(job); return { id: "job-1" }; },
  };
  return {
    root,
    statePath,
    calls,
    deps: {
      fetchImpl,
      linkBase: "https://link.v1d.io",
      token: "wsl-token",
      targets: ["lsrc:3"],
      agent,
      deliveryBroker,
      deliveryQueue: {
        read: (_agentName, _pane, id) => ({
          id,
          status: "acknowledged",
          acknowledgedAt: NOW,
        }),
      },
      statePath,
      sleep: async () => {},
      replyWaits: new Map(),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

feature("link connector cycle", () => {
  component("transcription failures are never mislabeled as pane failures", {
    given: ["three failure classes", () => [
      new Error("transcription empty; audio may have been silent"),
      new Error("transcription timeout after 60s"),
      new Error("reply-timeout"),
      new Error("fetch failed"),
    ]],
    when: ["classifying them", (errors) => errors.map(connectorFailureStage)],
    then: ["each operator-facing stage names its real subsystem", (stages) => {
      expect(stages).toEqual([
        "transcription-failed",
        "transcription-failed",
        "link-unavailable",
        "link-unavailable",
      ]);
    }],
  });

  component("invalid audio is terminal while transient transcription has a three-attempt bound", {
    given: ["empty, first transient, and third transient failures", () => [
      [Object.assign(new Error("transcription empty"), { status: 422 }), 1],
      [Object.assign(new Error("transcription failed: service 503"), { status: 500 }), 1],
      [Object.assign(new Error("transcription failed: service 503"), { status: 500 }), 3],
    ]],
    when: ["deciding their retry disposition", (cases) =>
      cases.map(([error, attempts]) => connectorFailureDisposition(error, attempts))],
    then: ["bad input stops once and infrastructure retries only within the bound", (result) => {
      expect(result).toEqual([
        { stage: "transcription-failed", terminal: true },
        { stage: "transcription-failed", terminal: false },
        { stage: "transcription-failed", terminal: true },
      ]);
    }],
  });

  component("claim to reply is journaled before every ack and idempotent on restart", {
    given: ["one claimed message and a working pane", () => harness({
      responses: { "/api/link/connector/poll?source=wsl": { messages: [message()] } },
    })],
    when: ["running the cycle twice (second one simulates a restart)", async (ctx) => {
      const first = await cycleWithReplies(ctx.deps);
      const second = await cycleWithReplies(ctx.deps);
      return { first, second, ctx };
    }],
    then: ["exactly one enqueue, one ack, one reply across both runs", (r) => {
      expect(r.first).toMatchObject({ claimed: 1, handled: 1 });
      expect(r.second).toMatchObject({ claimed: 1, handled: 0 });
      expect(r.ctx.calls.enqueued).toHaveLength(1);
      expect(r.ctx.calls.enqueued[0]).toMatchObject({
        agentName: "lsrc",
        pane: 3,
        idempotencyKey: "link:m-1",
      });
      expect(r.ctx.calls.enqueued[0].text).toBe("[amux-link-turn:m-1]\nhej från telefonen");
      const acks = r.ctx.calls.posts.filter((p) => p.url.includes("/ack"));
      const replies = r.ctx.calls.posts.filter((p) => p.url.includes("/reply"));
      expect(acks).toHaveLength(1);
      expect(replies).toHaveLength(1);
      expect(replies[0].body).toMatchObject({ clientMessageId: "m-1", body: "svar från pane" });
      const journal = JSON.parse(readFileSync(r.ctx.statePath, "utf8"));
      expect(journal.messages["m-1"].stage).toBe("replied");
      r.ctx.cleanup();
    }],
  });

  component("a claimed message redelivers after a mid-flight crash using the journal", {
    given: ["a journal that already delivered but never replied", () => {
      const ctx = harness({
        // The crash came after the ack landed, so the mailbox row carries it.
        // A row the mailbox never acked is row 187's repair case, not this one.
        responses: { "/api/link/connector/poll?source=wsl": { messages: [message({ state: "delivered", deliveredAt: NOW })] } },
      });
      const { writeFileSync } = require("node:fs");
      writeFileSync(ctx.statePath, JSON.stringify({
        version: 1,
        messages: { "m-1": { stage: "delivered", at: NOW, target: "lsrc:3", prompt: linkTurnPrompt(message()) } },
      }, null, 2));
      return ctx;
    }],
    when: ["running the cycle", async (ctx) => cycleWithReplies(ctx.deps)],
    then: ["no second enqueue and no second ack, reply still lands exactly once", (result, ctx) => {
      expect(result).toMatchObject({ claimed: 1, handled: 1 });
      expect(ctx.calls.enqueued).toHaveLength(0);
      expect(ctx.calls.posts.filter((p) => p.url.includes("/ack"))).toHaveLength(0);
      expect(ctx.calls.posts.filter((p) => p.url.includes("/reply"))).toHaveLength(1);
      ctx.cleanup();
    }],
  });

  component("mailbox down is an honest empty cycle, never a crash loop", {
    given: ["a link that refuses the poll", () => harness({
      responses: { "/api/link/connector/poll?source=wsl": new Error("link-poll-503") },
    })],
    when: ["running the cycle", async (ctx) => {
      try {
        return await cycleWithReplies(ctx.deps);
      } catch (error) {
        return { error: String(error.message) };
      }
    }],
    then: ["the failure is classified, nothing enqueued", (result, ctx) => {
      expect(result).toBeDefined();
      expect(ctx.calls.enqueued).toHaveLength(0);
      ctx.cleanup();
    }],
  });

  component("a voice message is downloaded and transcribed before delivery", {
    given: ["one voice message and a transcription", () => {
      const ctx = harness({
        responses: { "/api/link/connector/poll?source=wsl": { messages: [message({ kind: "voice", body: "", voiceRef: "voice/abc-123.m4a" })] } },
      });
      ctx.deps.transcribe = async (bytes) => `transkript: ${bytes.length} bytes`;
      return ctx;
    }],
    when: ["running the cycle", async (ctx) => cycleWithReplies(ctx.deps)],
    then: ["the pane gets the transcript, never the ref", (result, ctx) => {
      expect(result).toMatchObject({ claimed: 1, handled: 1 });
      expect(ctx.calls.enqueued).toHaveLength(1);
      expect(ctx.calls.enqueued[0].text).toBe("[amux-link-turn:m-1]\ntranskript: 16 bytes");
      expect(ctx.calls.posts.some((p) => p.url.includes("/api/link/voice/voice/abc-123.m4a"))).toBe(true);
      ctx.cleanup();
    }],
  });

  component("empty voice transcription posts one terminal failure and never reclaims locally", {
    given: ["one claimed voice message with no intelligible transcript", () => {
      const ctx = harness({
        responses: {
          "/api/link/connector/poll?source=wsl": {
            messages: [message({
              kind: "voice",
              body: "",
              voiceRef: "voice/empty-123.m4a",
              attempts: 1,
            })],
          },
        },
      });
      ctx.deps.transcribe = async () => "";
      return ctx;
    }],
    when: ["running the same claim twice", async (ctx) => {
      const first = await cycleWithReplies(ctx.deps);
      const second = await cycleWithReplies(ctx.deps);
      return { first, second, ctx };
    }],
    then: ["one fail is posted, nothing reaches a pane, and the journal prevents a loop", (result) => {
      expect(result.first).toMatchObject({ claimed: 1, handled: 0 });
      expect(result.second).toMatchObject({ claimed: 1, handled: 0 });
      expect(result.ctx.calls.enqueued).toHaveLength(0);
      expect(result.ctx.calls.posts.filter((post) => post.url.includes("/fail"))).toHaveLength(1);
      const journal = JSON.parse(readFileSync(result.ctx.statePath, "utf8"));
      expect(journal.messages["m-1"]).toMatchObject({
        stage: "failed",
        error: "transcription-failed",
      });
      result.ctx.cleanup();
    }],
  });

  component("planClaimedMessage stages", {
    given: ["one journal shape per mailbox shape", () => ({})],
    when: ["planning", () => [
      planClaimedMessage({ message: message(), journalEntry: null }),
      planClaimedMessage({ message: message({ deliveredAt: NOW }), journalEntry: { stage: "delivered" } }),
      planClaimedMessage({
        message: message({ state: "replied", deliveredAt: NOW, replyAt: NOW }),
        journalEntry: { stage: "replied" },
      }),
      // Row 187: the two shapes where the mailbox is behind the journal.
      planClaimedMessage({ message: message(), journalEntry: { stage: "delivered" } }),
      planClaimedMessage({
        message: message({ state: "delivered", deliveredAt: NOW }),
        journalEntry: { stage: "replied", reply: "svar från pane" },
      }),
    ]],
    then: ["deliver, await-reply, skip, then ack-repair and reply-repost", (plans) => {
      expect(plans.map((p) => p.action)).toEqual([
        "deliver", "await-reply", "skip", "await-reply", "repost-reply",
      ]);
      expect(plans[1].needsAck).toBe(false);
      expect(plans[3].needsAck).toBe(true);
      expect(plans[4]).toMatchObject({ needsAck: false, reply: "svar från pane" });
    }],
  });
});

feature("waitForLinkReply", () => {
  component("times out honestly when the pane never answers", {
    given: ["a pane with no response", () => ({
      agent: { hasResponseForPrompt: () => false, getResponseStreamWithRaw: async () => ({ items: [] }) },
    })],
    when: ["waiting with a tiny bound", async ({ agent }) => {
      try {
        await waitForLinkReply({ agent, target: "lsrc:3", prompt: "x", replyTimeoutMs: 1, sleep: async () => {} });
        return { ok: true };
      } catch (error) {
        return { error: String(error.message) };
      }
    }],
    then: ["reply-timeout, never a fabricated answer", (result) => {
      expect(result).toEqual({ error: "reply-timeout" });
    }],
  });
});

feature("redelivery dedup: a live broker job is never duplicated on reclaim", () => {
  const reclaimHarness = ({ existingJob }) => {
    const root = mkdtempSync(join(tmpdir(), "amux-link-dedup-"));
    const statePath = join(root, "connector.json");
    const enqueued = [];
    const posts = [];
    const fetchImpl = async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body || "{}") });
      if (url.includes("/connector/poll")) {
        return { ok: true, json: async () => ({ messages: [{ clientMessageId: "m-dup", target: "lsrc:3", kind: "text", body: "hej", attempts: 2 }] }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    return {
      root,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
      enqueued,
      posts,
      deps: {
        fetchImpl,
        linkBase: "https://link.v1d.io",
        token: "wsl-token",
        targets: ["lsrc:3"],
        agent: { hasResponseForPrompt: () => true, getResponseStreamWithRaw: async () => ({ items: [{ type: "text", content: "svar" }] }) },
        deliveryBroker: {
          enqueue: (job) => {
            enqueued.push(job.idempotencyKey);
            return existingJob;
          },
        },
        deliveryQueue: { read: () => existingJob },
        statePath,
        receiptTimeoutMs: 1,
        sleep: async () => {},
      },
    };
  };

  component("a pending first-attempt job keeps its key and its single pane write", {
    given: ["an existing pending job and a reclaimed message", () => reclaimHarness({ existingJob: { id: "job-1", status: "acknowledged", acknowledgedAt: 1 } })],
    when: ["running the cycle", async (ctx) => cycleWithReplies(ctx.deps)],
    then: ["the stable key is reused and no rotated key is created", (result, ctx) => {
      expect(result.handled).toBe(1);
      expect(ctx.enqueued).toEqual(["link:m-dup"]);
      expect(ctx.posts.filter((p) => p.url.includes("/ack"))).toHaveLength(1);
      ctx.cleanup();
    }],
  });

  component("only a cancelled job earns the rotated attempt key", {
    given: ["an existing cancelled job and a reclaimed message", () => reclaimHarness({ existingJob: { id: "job-1", status: "cancelled" } })],
    when: ["running the cycle", async (ctx) => cycleWithReplies(ctx.deps)],
    then: ["rotation happens exactly once, for the terminal job", (result, ctx) => {
      expect(ctx.enqueued[0]).toBe("link:m-dup");
      expect(ctx.enqueued[1]).toBe("link:m-dup:attempt:2");
      expect(ctx.enqueued).toHaveLength(2);
      expect(result.handled).toBe(0);
      ctx.cleanup();
    }],
  });
});
