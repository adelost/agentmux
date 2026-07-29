// Link connector cycle: journal-before-ack, restart safety, honest failure.

import { expect, feature, component } from "bdd-vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  linkTurnPrompt,
  planClaimedMessage,
  runLinkConnectorCycle,
  waitForLinkReply,
} from "./link-connector.mjs";

const NOW = Date.now();
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
  const fetchImpl = async (url, init) => {
    calls.posts.push({ url, body: JSON.parse(init.body || "{}") });
    const route = url.replace("https://link.v1d.io", "");
    const payload = responses[route] ?? (route.startsWith("/api/link/connector/poll") ? { messages: [] } : {});
    if (payload instanceof Error) throw payload;
    const voice = Buffer.from("FAKE-VOICE-BYTES");
    const voiceBytes = voice.buffer.slice(voice.byteOffset, voice.byteOffset + voice.byteLength);
    return { ok: true, json: async () => payload, arrayBuffer: async () => voiceBytes };
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
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

feature("link connector cycle", () => {
  component("claim to reply is journaled before every ack and idempotent on restart", {
    given: ["one claimed message and a working pane", () => harness({
      responses: { "/api/link/connector/poll?source=wsl": { messages: [message()] } },
    })],
    when: ["running the cycle twice (second one simulates a restart)", async (ctx) => {
      const first = await runLinkConnectorCycle(ctx.deps);
      const second = await runLinkConnectorCycle(ctx.deps);
      return { first, second, ctx };
    }],
    then: ["exactly one enqueue, one ack, one reply across both runs", (r) => {
      expect(r.first).toEqual({ claimed: 1, handled: 1 });
      expect(r.second).toEqual({ claimed: 1, handled: 0 });
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
        responses: { "/api/link/connector/poll?source=wsl": { messages: [message()] } },
      });
      const { writeFileSync } = require("node:fs");
      writeFileSync(ctx.statePath, JSON.stringify({
        version: 1,
        messages: { "m-1": { stage: "delivered", at: NOW, target: "lsrc:3", prompt: linkTurnPrompt(message()) } },
      }, null, 2));
      return ctx;
    }],
    when: ["running the cycle", async (ctx) => runLinkConnectorCycle(ctx.deps)],
    then: ["no second enqueue and no second ack, reply still lands exactly once", (result, ctx) => {
      expect(result).toEqual({ claimed: 1, handled: 1 });
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
        return await runLinkConnectorCycle(ctx.deps);
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
    when: ["running the cycle", async (ctx) => runLinkConnectorCycle(ctx.deps)],
    then: ["the pane gets the transcript, never the ref", (result, ctx) => {
      expect(result).toEqual({ claimed: 1, handled: 1 });
      expect(ctx.calls.enqueued).toHaveLength(1);
      expect(ctx.calls.enqueued[0].text).toBe("[amux-link-turn:m-1]\ntranskript: 16 bytes");
      expect(ctx.calls.posts.some((p) => p.url.includes("/api/link/voice/voice/abc-123.m4a"))).toBe(true);
      ctx.cleanup();
    }],
  });

  component("planClaimedMessage stages", {
    given: ["three journal shapes", () => ({})],
    when: ["planning", () => [
      planClaimedMessage({ message: message(), journalEntry: null }),
      planClaimedMessage({ message: message(), journalEntry: { stage: "delivered" } }),
      planClaimedMessage({ message: message(), journalEntry: { stage: "replied" } }),
    ]],
    then: ["deliver, await-reply, skip", (plans) => {
      expect(plans.map((p) => p.action)).toEqual(["deliver", "await-reply", "skip"]);
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
    when: ["running the cycle", async (ctx) => runLinkConnectorCycle(ctx.deps)],
    then: ["the stable key is reused and no rotated key is created", (result, ctx) => {
      expect(result.handled).toBe(1);
      expect(ctx.enqueued).toEqual(["link:m-dup"]);
      expect(ctx.posts.filter((p) => p.url.includes("/ack"))).toHaveLength(1);
      ctx.cleanup();
    }],
  });

  component("only a cancelled job earns the rotated attempt key", {
    given: ["an existing cancelled job and a reclaimed message", () => reclaimHarness({ existingJob: { id: "job-1", status: "cancelled" } })],
    when: ["running the cycle", async (ctx) => runLinkConnectorCycle(ctx.deps)],
    then: ["rotation happens exactly once, for the terminal job", (result, ctx) => {
      expect(ctx.enqueued[0]).toBe("link:m-dup");
      expect(ctx.enqueued[1]).toBe("link:m-dup:attempt:2");
      expect(ctx.enqueued).toHaveLength(2);
      expect(result.handled).toBe(0);
      ctx.cleanup();
    }],
  });
});
