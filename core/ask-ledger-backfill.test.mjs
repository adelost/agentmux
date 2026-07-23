import { expect, feature, unit } from "bdd-vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAskLedger, readAskLedger } from "./ask-ledger.mjs";
import {
  backfillAskLedgerFromDeliveryQueue,
  defaultAskBackfillMarkerPath,
} from "./ask-ledger-backfill.mjs";
import { inferAskOrigin } from "./ask-origin.mjs";

const freshRoot = () => mkdtempSync(join(tmpdir(), "amux-ask-backfill-"));

function writeLegacyJob(queueDir, {
  id,
  agentName = "skydive",
  pane = 8,
  text,
  source = "discord",
  kind = "prompt",
  status = "acknowledged",
  createdAt = Date.parse("2026-07-22T03:25:04.000Z"),
  metadata = {},
} = {}) {
  const target = join(queueDir, `${agentName}--p${pane}`);
  mkdirSync(target, { recursive: true });
  const path = join(target, `${id}.json`);
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    id,
    agentName,
    pane,
    text,
    source,
    kind,
    status,
    createdAt,
    metadata,
    echoCursor: { positions: { "/sessions/old.jsonl": 123 } },
  })}\n`);
  return path;
}

feature("ask ledger delivery backfill", () => {
  unit("indexes a pre-ledger human ask once with honest unresolved evidence", {
    given: ["a ledger that starts after an older persisted delivery", () => {
      const root = freshRoot();
      const queueDir = join(root, "delivery-queue");
      const ledgerPath = join(root, "ask-ledger.jsonl");
      appendAskLedger({
        id: "new", ts: "2026-07-22T19:05:00Z", agent: "skydive", pane: 3,
        source: "discord", verbatim: "new ask",
      }, { path: ledgerPath });
      const prompt = "Borde vi ha människor som går runt i världen och på vägar?";
      const deliveryPath = writeLegacyJob(queueDir, { id: "npc-job", text: prompt });
      return { root, queueDir, ledgerPath, prompt, deliveryPath };
    }],
    when: ["the automatic migration runs twice", (ctx) => {
      const first = backfillAskLedgerFromDeliveryQueue({
        queueDir: ctx.queueDir,
        ledgerPath: ctx.ledgerPath,
        now: () => Date.parse("2026-07-23T04:00:00Z"),
      });
      const second = backfillAskLedgerFromDeliveryQueue({
        queueDir: ctx.queueDir,
        ledgerPath: ctx.ledgerPath,
        now: () => Date.parse("2026-07-23T04:00:01Z"),
      });
      return { first, second, rows: readAskLedger({ path: ctx.ledgerPath }) };
    }],
    then: ["the old ask is durable, human-labelled, evidenced, and never duplicated", (result, ctx) => {
      try {
        expect(result.first).toMatchObject({ scanned: 1, imported: 1, enriched: 0, skipped: false });
        expect(result.second).toMatchObject({ skipped: true, imported: 1 });
        expect(result.rows).toHaveLength(2);
        expect(result.rows.find((row) => row.id === "delivery:npc-job")).toMatchObject({
          verbatim: ctx.prompt,
          source: "discord",
          origin: "human",
          deliveryStatus: "acknowledged",
          deliveryPath: ctx.deliveryPath,
          sessionFile: "/sessions/old.jsonl",
          backfilled: true,
        });
        expect(JSON.parse(readFileSync(defaultAskBackfillMarkerPath(ctx.ledgerPath), "utf8")))
          .toMatchObject({ version: 1, imported: 1 });
      } finally {
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }],
  });

  unit("enriches an existing delivery identity and excludes machine plumbing", {
    given: ["one pre-captured ask plus a slash command in the old queue", () => {
      const root = freshRoot();
      const queueDir = join(root, "delivery-queue");
      const ledgerPath = join(root, "ask-ledger.jsonl");
      appendAskLedger({
        id: "delivery:existing", ts: "2026-07-22T12:00:00Z",
        agent: "skydive", pane: 3, source: "discord", verbatim: "fixa bron",
      }, { path: ledgerPath });
      writeLegacyJob(queueDir, {
        id: "existing", pane: 3, text: "fixa bron",
        createdAt: Date.parse("2026-07-22T12:00:00Z"),
      });
      writeLegacyJob(queueDir, {
        id: "compact", pane: 3, text: "/compact", kind: "slash",
      });
      return { root, queueDir, ledgerPath };
    }],
    when: ["the old queue is migrated", (ctx) => ({
      result: backfillAskLedgerFromDeliveryQueue({
        queueDir: ctx.queueDir, ledgerPath: ctx.ledgerPath,
      }),
      rows: readAskLedger({ path: ctx.ledgerPath }),
    })],
    then: ["the existing row gains proof while the command stays absent", ({ result, rows }, ctx) => {
      try {
        expect(result).toMatchObject({ scanned: 2, imported: 0, enriched: 1, ignored: 1 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          id: "delivery:existing",
          deliveryStatus: "acknowledged",
          origin: "human",
        });
      } finally {
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }],
  });
});

feature("ask origin", () => {
  unit("distinguishes the human, agent, and automation paths used by the fleet", {
    when: ["classifying representative prompts", () => [
      inferAskOrigin({ source: "discord", prompt: "kan du fixa detta?" }),
      inferAskOrigin({ source: "cli", sender: "skydive:2", prompt: "[from skydive:2] fixa" }),
      inferAskOrigin({ source: "auto-compact", prompt: "/compact" }),
    ]],
    then: ["their origins remain explicit", (origins) =>
      expect(origins).toEqual(["human", "agent", "system"])],
  });
});
