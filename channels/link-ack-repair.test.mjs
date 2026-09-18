// Row 187: the journal is the connector's memory, not the mailbox's truth. When
// the two disagree the connector repairs the mailbox on the next claim, because
// the phone reads the mailbox. Measured on production 2026-09-18: Mattias's
// "hej" to lsrc:3 was journalled delivered, the mailbox never recorded the ack,
// lsrc:3 answered in its pane, and the answer never reached him while the row
// was re-claimed 377 times.

import { expect, feature, component } from "bdd-vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLinkConnectorCycle, linkTurnPrompt } from "./link-connector.mjs";

const ID = "5f7026ca-0000-4000-8000-000000000001";
const ANSWER = "Hej! Jag hör dig.";
const PROMPT = linkTurnPrompt({ clientMessageId: ID, body: "hej" });

const ok = (value) => ({ ok: true, json: async () => value });

/**
 * A connector against a mailbox that keeps state, so a test can assert what the
 * phone would see rather than which calls were made. `lostAcks` models the one
 * failure this row is about: the ack leaves the connector and the mailbox row
 * never records it.
 */
function harness({ journalEntry = null, row = {}, answersNow = false, lostAcks = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-link-ack-"));
  const statePath = join(root, "connector.json");
  if (journalEntry) {
    writeFileSync(statePath, JSON.stringify({ version: 1, messages: { [ID]: journalEntry } }), "utf8");
  }
  const mailbox = {
    clientMessageId: ID, target: "lsrc:3", kind: "text", body: "hej",
    state: "leased", attempts: 1, deliveredAt: null, replyAt: null, replyBody: null, lastError: null,
    ...row,
  };
  const answered = new Set(answersNow ? [ID] : []);
  const posts = [];
  const enqueued = [];
  let acksToLose = lostAcks;
  return {
    mailbox,
    answered,
    posts,
    enqueued,
    calls: (kind) => posts.filter((post) => post.url.includes(`/connector/${kind}`)).length,
    journal: () => JSON.parse(readFileSync(statePath, "utf8")).messages[ID],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    deps: {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body || "{}");
        posts.push({ url, body });
        if (url.includes("/connector/poll")) {
          if (mailbox.state === "replied" || mailbox.state === "failed") return ok({ messages: [] });
          mailbox.attempts += 1;
          return ok({ messages: [{ ...mailbox }] });
        }
        if (url.includes("/connector/ack")) {
          if (acksToLose > 0) {
            acksToLose -= 1;
            return ok({ state: "delivered", reason: "lost-before-the-row-was-written" });
          }
          mailbox.state = "delivered";
          mailbox.deliveredAt = Date.now();
          return ok({ state: "delivered" });
        }
        if (url.includes("/connector/reply")) {
          // The worker's own rule (replyDecision): a reply counts only from the
          // connector that delivered it. An unacked row therefore answers 409,
          // and that is where a real answer dies today.
          if (mailbox.state !== "delivered") {
            return { ok: false, status: 409, json: async () => ({ error: "not-delivered-by-connector" }) };
          }
          mailbox.state = "replied";
          mailbox.replyAt = Date.now();
          mailbox.replyBody = body.body;
          return ok({ state: "replied" });
        }
        if (url.includes("/connector/fail")) {
          mailbox.state = "failed";
          mailbox.lastError = body.error;
          return ok({ state: "failed" });
        }
        return ok({});
      },
      linkBase: "https://link.v1d.io",
      token: "wsl-token",
      targets: [{ id: "lsrc:3", label: "L-source 3" }],
      agent: {
        hasResponseForPrompt: () => answered.has(ID),
        getResponseStreamWithRaw: async () => ({ items: [{ type: "text", content: ANSWER }] }),
      },
      deliveryBroker: {
        enqueue: ({ agentName, pane, idempotencyKey }) => {
          enqueued.push(idempotencyKey);
          return { id: `job-${agentName}-${pane}` };
        },
      },
      deliveryQueue: { read: (_a, _p, id) => ({ id, status: "acknowledged", acknowledgedAt: Date.now() }) },
      statePath,
      replyTimeoutMs: 300,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
      replyWaits: new Map(),
    },
  };
}

const runCycle = async (h) => {
  const result = await runLinkConnectorCycle(h.deps);
  await Promise.all(result.started ?? []);
  return result;
};

feature("the connector repairs a mailbox that lost an ack or a reply", () => {
  component("a lost ack is re-sent on the next claim, and the pane's answer still lands", {
    given: ["a turn whose ack never reached the mailbox, answered after the first wait gave up", () => harness({ lostAcks: 1 })],
    when: ["the cycle runs, the pane answers, and the worker re-claims the message", async (h) => {
      await runCycle(h);                       // delivered, ack lost, nobody answered yet
      const afterFirst = { ...h.mailbox };
      h.answered.add(ID);                      // lsrc:3 answers, late, as it did live
      await runCycle(h);
      const out = {
        afterFirst,
        state: h.mailbox.state,
        reply: h.mailbox.replyBody,
        acks: h.calls("ack"),
        replies: h.calls("reply"),
        enqueued: h.enqueued.length,
      };
      h.cleanup();
      return out;
    }],
    then: ["the second claim acks again and the answer reaches the mailbox once", (r) => {
      expect(r.afterFirst.state).toBe("leased");
      expect(r.afterFirst.deliveredAt).toBeNull();
      // The repair: without a second ack the reply is refused and the answer is lost.
      expect(r.acks).toBe(2);
      expect(r.state).toBe("replied");
      expect(r.reply).toBe(ANSWER);
      expect(r.replies).toBe(1);
      // Repairing is not redelivering: the pane is written to exactly once.
      expect(r.enqueued).toBe(1);
    }],
  });

  component("a reply the mailbox never recorded is re-posted from the journal", {
    given: ["a journal that says replied over a mailbox row that says delivered", () => harness({
      row: { state: "delivered", deliveredAt: Date.now() - 60_000 },
      journalEntry: { stage: "replied", target: "lsrc:3", prompt: PROMPT, reply: ANSWER, replyAt: Date.now() - 30_000 },
    })],
    when: ["the worker re-claims it", async (h) => {
      await runCycle(h);
      const out = { state: h.mailbox.state, reply: h.mailbox.replyBody, replies: h.calls("reply"), enqueued: h.enqueued.length };
      h.cleanup();
      return out;
    }],
    then: ["the stored answer is posted once, with no second delivery", (r) => {
      expect(r.state).toBe("replied");
      expect(r.reply).toBe(ANSWER);
      expect(r.replies).toBe(1);
      expect(r.enqueued).toBe(0);
    }],
  });

  component("the production shape: journal replied, mailbox never acked", {
    given: ["both halves broken at once", () => harness({
      journalEntry: { stage: "replied", target: "lsrc:3", prompt: PROMPT, reply: ANSWER, replyAt: Date.now() - 30_000 },
    })],
    when: ["the worker re-claims it", async (h) => {
      await runCycle(h);
      const out = { state: h.mailbox.state, reply: h.mailbox.replyBody, acks: h.calls("ack"), replies: h.calls("reply") };
      h.cleanup();
      return out;
    }],
    then: ["it is acked first, then replied, and it leaves the queue", (r) => {
      expect(r.acks).toBe(1);
      expect(r.replies).toBe(1);
      expect(r.state).toBe("replied");
      expect(r.reply).toBe(ANSWER);
    }],
  });

  component("a mailbox that already agrees is left alone", {
    given: ["a journal and a mailbox that both say replied", () => harness({
      row: { state: "replied", deliveredAt: Date.now() - 60_000, replyAt: Date.now() - 30_000, replyBody: ANSWER },
      journalEntry: { stage: "replied", target: "lsrc:3", prompt: PROMPT, reply: ANSWER, replyAt: Date.now() - 30_000 },
    })],
    when: ["a cycle runs", async (h) => {
      // A replied row is no longer handed out; the claim below is the belt-and-braces
      // case where it is, and must still not post a second reply.
      h.mailbox.state = "delivered";
      h.mailbox.replyAt = Date.now();
      h.mailbox.replyBody = ANSWER;
      await runCycle(h);
      const out = { replies: h.calls("reply"), acks: h.calls("ack"), enqueued: h.enqueued.length };
      h.cleanup();
      return out;
    }],
    then: ["nothing is posted for it", (r) => {
      expect(r.replies).toBe(0);
      expect(r.acks).toBe(0);
      expect(r.enqueued).toBe(0);
    }],
  });
});
