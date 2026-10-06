import { expect, feature, unit } from "bdd-vitest";
import {
  mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAskLedger,
  askLedgerFiles,
  capturePaneHookAsk,
  coalesceAskLedger,
  persistAskCompletionEvidence,
  readAskLedger,
} from "./ask-ledger.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";

const freshRoot = () => mkdtempSync(join(tmpdir(), "amux-ask-ledger-"));
const minutesAfter = (minutes) => new Date(Date.parse("2026-10-01T08:00:00Z") + minutes * 60_000).toISOString();
const delivered = (id, minute, pane = 1, verbatim = "kör testerna") => ({
  id, ts: minutesAfter(minute), agent: "lsrc", pane, source: "discord", verbatim,
});
const hooked = (id, minute, pane = 1, verbatim = "kör testerna") => ({
  id, ts: minutesAfter(minute), agent: "lsrc", pane, source: "pane-hook", verbatim,
  sessionFile: `/sessions/${id}.jsonl`,
});

// Every delivered ask is echoed by its pane hook, and as many prompts are typed
// straight into panes. Comparing every hook with every delivery is quadratic.
function fleetLedger(count) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const at = (offsetMs) => new Date(Date.parse("2026-09-01T00:00:00Z") + i * 60_000 + offsetMs).toISOString();
    const pane = { agent: `agent${i % 8}`, pane: i % 6 };
    const verbatim = `kör uppdrag ${i} och rapportera med bevis`;
    rows.push(
      { ...pane, id: `delivery:${i}`, ts: at(0), source: "discord", verbatim },
      { ...pane, id: `echo:${i}`, ts: at(2_000), source: "pane-hook", verbatim, sessionFile: `/sessions/${i}.jsonl` },
      { ...pane, id: `typed:${i}`, ts: at(3_000), source: "pane-hook", verbatim: `skrivet direkt ${i}` },
    );
  }
  return rows;
}

const cpuMsOf = (work) => {
  const before = process.cpuUsage();
  const result = work();
  const used = process.cpuUsage(before);
  return { result, cpuMs: (used.user + used.system) / 1000 };
};

feature("durable ask ledger", () => {
  unit("preserves exact UTF-8 and concrete session provenance", {
    given: ["a pane prompt with Swedish text", () => {
      const root = freshRoot();
      const path = join(root, "ask-ledger.jsonl");
      const sessionFile = join(root, "session.jsonl");
      const verbatim = "påminn mig om höjdmätaren — åäö 🌤️";
      capturePaneHookAsk({
        hook_event_name: "UserPromptSubmit",
        prompt: verbatim,
        transcript_path: sessionFile,
        session_id: "session-17",
        cwd: "/home/adelost/lsrc/skydive-altimeter/.agents/4",
        timestamp: "2026-07-22T10:00:00.000Z",
      }, { session: "skyvw", pane: 4 }, { path });
      return { root, path, verbatim, sessionFile };
    }],
    when: ["the append-only ledger is reopened", ({ path }) => readAskLedger({ path })],
    then: ["the exact bytes and pointers survive", (rows, ctx) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        agent: "skyvw", pane: 4, source: "pane-hook",
        verbatim: ctx.verbatim, sessionFile: ctx.sessionFile,
        sessionId: "session-17",
      });
      expect(readFileSync(ctx.path, "utf8")).toContain(ctx.verbatim);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  unit("rotates by archive rename without losing old asks", {
    given: ["one full ledger", () => {
      const root = freshRoot();
      const path = join(root, "ask-ledger.jsonl");
      appendAskLedger({
        ts: "2026-07-22T10:00:00Z", agent: "skyvw", pane: 1,
        source: "discord", verbatim: "first durable ask",
      }, { path, maxBytes: 1, now: () => Date.parse("2026-07-22T10:00:00Z") });
      appendAskLedger({
        ts: "2026-07-22T10:01:00Z", agent: "skyvw", pane: 1,
        source: "discord", verbatim: "second durable ask",
      }, { path, maxBytes: 1, now: () => Date.parse("2026-07-22T10:01:00Z") });
      return { root, path };
    }],
    when: ["archives and current rows are read together", ({ path }) => ({
      files: askLedgerFiles(path), rows: readAskLedger({ path }),
    })],
    then: ["both asks remain in chronological order", ({ files, rows }, ctx) => {
      expect(files).toHaveLength(2);
      expect(rows.map((row) => row.verbatim)).toEqual([
        "first durable ask", "second durable ask",
      ]);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  unit("delivery records memory before target classification and spool creation", {
    given: ["an empty isolated delivery queue", () => {
      const root = freshRoot();
      return { root, queue: createDeliveryQueue({ rootDir: join(root, "queue"), now: () => 42 }) };
    }],
    when: ["a direct amux prompt is queued", ({ queue }) => queue.enqueue({
      agentName: "skyvw", pane: 4, source: "amux-send",
      text: "gör den deklarativ och glöm inte åäö",
      metadata: { cwd: "/repo", sessionId: "sender-session" },
    })],
    then: ["the exact directive is already in the queue-local ledger", (job, ctx) => {
      const rows = readAskLedger({ path: join(ctx.root, "queue", "ask-ledger.jsonl") });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: `delivery:${job.id}`,
        source: "amux-send",
        verbatim: "gör den deklarativ och glöm inte åäö",
        deliveryId: job.id,
      });
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  unit("an ask outlives deletion of its provider session file", {
    given: ["a captured ask and its live session", () => {
      const root = freshRoot();
      const path = join(root, "ask-ledger.jsonl");
      const sessionFile = join(root, "dead-session.jsonl");
      writeFileSync(sessionFile, "{}\n");
      capturePaneHookAsk({
        hook_event_name: "UserPromptSubmit", prompt: "det här får aldrig glömmas",
        transcript_path: sessionFile, session_id: "dead", cwd: "/repo",
      }, { session: "skyvw", pane: 0 }, { path });
      unlinkSync(sessionFile);
      return { root, path, sessionFile };
    }],
    when: ["the now-orphaned ledger is reopened", ({ path }) => readAskLedger({ path })],
    then: ["the directive and dead pointer remain", (rows, ctx) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        verbatim: "det här får aldrig glömmas", sessionFile: ctx.sessionFile,
      });
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  unit("a verified live completion becomes durable before its session is trimmed", {
    given: ["one durable ask joined to a finished provider turn", () => {
      const root = freshRoot();
      const path = join(root, "ask-ledger.jsonl");
      appendAskLedger({
        id: "delivery:done-1",
        ts: "2026-07-22T10:00:00Z",
        agent: "skydive",
        pane: 8,
        source: "discord",
        verbatim: "fixa uppdraget",
      }, { path });
      return {
        root,
        path,
        ledgerEntries: readAskLedger({ path }),
        joinedEntries: [{
          ledgerId: "delivery:done-1",
          status: "done",
          reply: "Klart och live.",
          replyPreview: "Klart och live.",
          timestamp: "2026-07-22T10:00:00Z",
          endTimestamp: "2026-07-22T10:03:00Z",
          jsonlFile: "/sessions/proof.jsonl",
        }],
      };
    }],
    when: ["completion evidence is persisted twice", (ctx) => {
      const first = persistAskCompletionEvidence({
        ledgerEntries: ctx.ledgerEntries,
        joinedEntries: ctx.joinedEntries,
        path: ctx.path,
      });
      const reloaded = readAskLedger({ path: ctx.path });
      const second = persistAskCompletionEvidence({
        ledgerEntries: reloaded,
        joinedEntries: ctx.joinedEntries,
        path: ctx.path,
      });
      return { first, second, rows: readAskLedger({ path: ctx.path }) };
    }],
    then: ["the same ask carries exactly one terminal receipt independent of provider history", ({ first, second, rows }, ctx) => {
      try {
        expect(first).toBe(1);
        expect(second).toBe(0);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: "delivery:done-1",
          completionStatus: "done",
          completionReply: "Klart och live.",
          completionAt: "2026-07-22T10:03:00Z",
          completionSessionFile: "/sessions/proof.jsonl",
        });
      } finally {
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }],
  });

  unit("a pane hook folds into the nearest unclaimed identical delivery on its own pane", {
    given: ["repeated identical asks, their hook echoes, and near misses", () => [
      delivered("d-first", 0), delivered("d-second", 10),
      hooked("h-near-second", 9), hooked("h-takes-first", 11), hooked("h-both-claimed", 12),
      hooked("h-other-pane", 0, 2),
      delivered("d-late", 60), hooked("h-too-early", 40),
      delivered("d-tie-early", 115), delivered("d-tie-late", 125), hooked("h-tie", 120),
    ]],
    when: ["the ledger rows are coalesced", (rows) => coalesceAskLedger(rows)],
    then: ["each delivery keeps the session of the hook that claimed it and the rest stay standalone", (rows) => {
      const sessionOf = Object.fromEntries(rows.filter((row) => row.source === "discord")
        .map((row) => [row.id, row.sessionFile ?? null]));
      expect(sessionOf).toEqual({
        "d-first": "/sessions/h-takes-first.jsonl",
        "d-second": "/sessions/h-near-second.jsonl",
        "d-late": null,
        "d-tie-early": "/sessions/h-tie.jsonl",
        "d-tie-late": null,
      });
      expect(rows.filter((row) => row.source === "pane-hook").map((row) => row.id))
        .toEqual(["h-other-pane", "h-both-claimed", "h-too-early"]);
    }],
  });

  unit("a fleet-sized ledger coalesces in time proportional to its rows, not rows squared", {
    given: ["4,000 delivered asks with hook echoes and 4,000 typed prompts", () => fleetLedger(4_000)],
    when: ["the ledger rows are coalesced", (rows) => cpuMsOf(() => coalesceAskLedger(rows))],
    then: ["every echo folds into its delivery and the pass stays far below a pairwise scan", ({ result, cpuMs }) => {
      expect(result).toHaveLength(8_000);
      expect(result.filter((row) => row.source === "discord")
        .every((row) => row.sessionFile === `/sessions/${row.id.slice("delivery:".length)}.jsonl`)).toBe(true);
      expect(cpuMs).toBeLessThan(250);
    }],
  });
});
