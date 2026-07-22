import { expect, feature, unit } from "bdd-vitest";
import {
  mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAskLedger, askLedgerFiles, capturePaneHookAsk, readAskLedger,
} from "./ask-ledger.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";

const freshRoot = () => mkdtempSync(join(tmpdir(), "amux-ask-ledger-"));

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
});
