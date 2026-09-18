// Row 186: one silent pane must not hold the connector. The cycle claims,
// delivers and returns; each reply wait runs beside it, keyed by
// clientMessageId, so the poll and the beat keep their cadence and every other
// pane's turn lands while the silent one is still thinking.

import { expect, feature, component } from "bdd-vitest";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLinkConnectorCycle, linkTurnPrompt } from "./link-connector.mjs";

const SILENT = "aaaaaaaa-0000-4000-8000-000000000001";
const ANSWERS = "bbbbbbbb-0000-4000-8000-000000000002";

const message = (id, target, body) => ({
  clientMessageId: id, target, kind: "text", body, attempts: 1, state: "leased",
});

/** A connector whose first poll claims a silent pane's turn and an answering
 *  pane's turn, in that order: the silent one is first in line on purpose. */
function harness({ claims = [[message(SILENT, "lsrc:3", "tyst"), message(ANSWERS, "skyvw:2", "svara")]] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-link-tasks-"));
  const posts = [];
  const answered = new Set([ANSWERS]);
  let poll = 0;
  return {
    root,
    posts,
    answered,
    polls: () => posts.filter((post) => post.url.includes("/connector/poll")).length,
    replies: () => posts.filter((post) => post.url.includes("/connector/reply")).map((post) => post.body.clientMessageId),
    journal: () => JSON.parse(readFileSync(join(root, "connector.json"), "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    deps: {
      fetchImpl: async (url, init) => {
        const body = JSON.parse(init.body || "{}");
        posts.push({ url, body });
        if (url.includes("/connector/poll")) {
          const messages = claims[poll] ?? [];
          poll += 1;
          return { ok: true, json: async () => ({ messages }) };
        }
        return { ok: true, json: async () => ({}) };
      },
      linkBase: "https://link.v1d.io",
      token: "wsl-token",
      targets: [{ id: "lsrc:3", label: "L-source 3" }, { id: "skyvw:2", label: "Skyvw two" }],
      agent: {
        hasResponseForPrompt: (_name, _pane, prompt) =>
          [...answered].some((id) => prompt.includes(id)),
        getResponseStreamWithRaw: async () => ({ items: [{ type: "text", content: "svar" }] }),
      },
      deliveryBroker: { enqueue: ({ agentName }) => ({ id: `job-${agentName}` }) },
      deliveryQueue: { read: (_a, _p, id) => ({ id, status: "acknowledged", acknowledgedAt: Date.now() }) },
      statePath: join(root, "connector.json"),
      // Short enough that a silent wait cannot outlive the test, long enough
      // that a cycle serialising on it would be unmistakable.
      replyTimeoutMs: 3_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
      replyWaits: new Map(),
    },
  };
}

feature("a silent pane no longer holds the connector", () => {
  component("the answering pane is delivered and replied while the silent one still waits", {
    given: ["one silent turn claimed before one that answers", () => harness()],
    when: ["running a single cycle", async (h) => {
      const startedAt = Date.now();
      const result = await runLinkConnectorCycle(h.deps);
      const cycleMs = Date.now() - startedAt;
      // The answering pane's wait is the one that finishes; join only that.
      const answering = result.started[result.pending.indexOf(ANSWERS)];
      await answering;
      const out = {
        cycleMs, pending: result.pending, replies: h.replies(), journal: h.journal(),
        prompt: linkTurnPrompt({ clientMessageId: ANSWERS, body: "svara" }),
      };
      // Let the silent wait finish so nothing is left running after the test.
      h.answered.add(SILENT);
      await Promise.all(result.started);
      h.cleanup();
      return out;
    }],
    then: ["the cycle returned at once, B replied, A was still pending", (r) => {
      expect(r.pending).toEqual([SILENT, ANSWERS]);
      expect(r.replies).toEqual([ANSWERS]);
      expect(r.journal.messages[ANSWERS].stage).toBe("replied");
      expect(r.journal.messages[SILENT].stage).toBe("delivered");
      // On the serial cycle this could not be under the reply timeout: B was
      // only delivered after A's full wait.
      expect(r.cycleMs).toBeLessThan(1_000);
    }],
  });

  // Shape-independent on purpose: this one reads only what the mailbox sees, so
  // it stays a fair measurement of the defect on any version of the cycle.
  component("the answering pane's reply reaches the mailbox before the silent pane's wait ends", {
    given: ["one silent turn claimed before one that answers", () => harness()],
    when: ["running the cycle and watching the posts", async (h) => {
      const startedAt = Date.now();
      const cycle = runLinkConnectorCycle(h.deps);
      let repliedAtMs = null;
      // Poll the posts for at most one reply timeout; the point is WHEN B lands.
      while (Date.now() - startedAt < h.deps.replyTimeoutMs + 500) {
        if (h.replies().includes(ANSWERS)) { repliedAtMs = Date.now() - startedAt; break; }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const result = await cycle.catch(() => null);
      h.answered.add(SILENT);
      await Promise.all(result?.started ?? []);
      h.cleanup();
      return { repliedAtMs, timeout: h.deps.replyTimeoutMs };
    }],
    then: ["B's reply is posted while A is still silent, not after A's timeout", (r) => {
      expect(r.repliedAtMs).not.toBeNull();
      expect(r.repliedAtMs).toBeLessThan(r.timeout / 3);
    }],
  });

  component("the poll keeps its cadence while a pane stays silent", {
    given: ["one silent turn claimed on the first poll", () => harness({
      claims: [[message(SILENT, "lsrc:3", "tyst")]],
    })],
    when: ["running three cycles back to back", async (h) => {
      const startedAt = Date.now();
      const results = [];
      for (let i = 0; i < 3; i++) results.push(await runLinkConnectorCycle(h.deps));
      const out = { elapsedMs: Date.now() - startedAt, polls: h.polls(), pending: results.at(-1).pending };
      h.answered.add(SILENT);
      await Promise.all(results.flatMap((result) => result.started));
      h.cleanup();
      return out;
    }],
    then: ["three cycles, three polls, no cycle waited for the silent pane", (r) => {
      expect(r.polls).toBe(3);
      expect(r.pending).toEqual([SILENT]);
      // Serially this took one reply timeout per cycle, nine seconds here.
      expect(r.elapsedMs).toBeLessThan(1_000);
    }],
  });

  component("a message re-claimed while its wait runs starts no second wait", {
    given: ["the same turn claimed on two polls in a row", () => harness({
      claims: [[message(SILENT, "lsrc:3", "tyst")], [message(SILENT, "lsrc:3", "tyst")]],
    })],
    when: ["running both cycles and then letting the pane answer", async (h) => {
      const first = await runLinkConnectorCycle(h.deps);
      const second = await runLinkConnectorCycle(h.deps);
      const pendingAfterSecond = second.pending;
      h.answered.add(SILENT);
      await Promise.all([...first.started, ...second.started]);
      const out = { pendingAfterSecond, started: second.started.length, replies: h.replies() };
      h.cleanup();
      return out;
    }],
    then: ["one wait, one reply for the turn", (r) => {
      expect(r.pendingAfterSecond).toEqual([SILENT]);
      expect(r.started).toBe(0);
      expect(r.replies).toEqual([SILENT]);
    }],
  });

  component("a restart re-adopts a delivered turn that was never answered", {
    given: ["a journal that says delivered and no wait in this process", () => {
      // The mailbox carries the ack it recorded before the restart; a row it
      // never acked is row 187's repair case, and has its own test.
      const h = harness({ claims: [[{ ...message(ANSWERS, "skyvw:2", "svara"), state: "delivered", deliveredAt: Date.now() }]] });
      // What a restart looks like: the journal survived, the wait did not.
      const statePath = h.deps.statePath;
      mkdirSync(h.root, { recursive: true });
      writeFileSync(statePath, JSON.stringify({
        version: 1,
        messages: {
          [ANSWERS]: {
            stage: "delivered",
            target: "skyvw:2",
            prompt: linkTurnPrompt({ clientMessageId: ANSWERS, body: "svara" }),
          },
        },
      }), "utf8");
      return h;
    }],
    when: ["the worker re-claims it after the lease", async (h) => {
      const result = await runLinkConnectorCycle(h.deps);
      await Promise.all(result.started);
      const out = {
        replies: h.replies(),
        journal: h.journal(),
        enqueued: h.posts.filter((post) => post.url.includes("/connector/ack")).length,
      };
      h.cleanup();
      return out;
    }],
    then: ["it waits again and replies, without a second delivery", (r) => {
      expect(r.replies).toEqual([ANSWERS]);
      expect(r.journal.messages[ANSWERS].stage).toBe("replied");
      expect(r.enqueued).toBe(0);
    }],
  });
});
