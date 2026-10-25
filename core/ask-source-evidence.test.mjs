import { component, feature, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { resolveAskSourceEvidence, observedAskOrigin, readAskProducers } from "./ask-source-evidence.mjs";
import { inferAskOrigin } from "./ask-origin.mjs";

const ts = "2026-10-25T11:01:10.337Z";
const ask = (id, extra = {}) => ({ id, ts, agent: "api", pane: 0, source: "pane-hook", verbatim: "A real order", ...extra });
const origin = row => observedAskOrigin(row, inferAskOrigin);

feature("ask provenance uses producer facts rather than prompt filters", () => {
  component("the actual Claude scheduled envelope is not a human order", {
    when: ["the journal carries the observed scheduled metadata", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-ask-source-")), path = join(root, "session.jsonl");
      writeFileSync(path, JSON.stringify({ type: "user", uuid: "native-uuid", timestamp: ts, isMeta: true,
        promptSource: "system", wakeupSource: "schedule_wakeup", turnOrigin: "scheduled", scheduledTaskId: "8b364ec9",
        message: { role: "user", content: "A real order" } }) + "\n");
      return resolveAskSourceEvidence([ask("hook", { sessionFile: path })], { producers: [] })[0];
    }],
    then: ["source evidence says system and preserves the original ID", row => {
      expect(origin(row)).toBe("system"); expect(row.observationIds).toEqual(["hook"]);
      expect(row.originEvidence.fields.scheduledTaskId).toBe("8b364ec9");
    }],
  });
  component("a human mentioning a timer is never hidden by its words", {
    when: ["there is no native or transport proof", () => resolveAskSourceEvidence([
      ask("human", { verbatim: "dispatch-checkpoint-: fix this timer", sessionFile: "/missing/session.jsonl" }),
    ], { producers: [] })[0]],
    then: ["the original order remains visibly uncertain", row => { expect(origin(row)).toBe("unknown"); expect(row.originEvidence).toBeUndefined(); expect(row.observationIds).toEqual(["human"]); }],
  });
  component("a delivery and engine backfill of one native event retain both source IDs", {
    when: ["both observations point to the same native event", () => resolveAskSourceEvidence([
      ask("engine", { source: "engine-backfill", sessionFile: "/fixture/session.jsonl" }),
      ask("delivery:original", { source: "discord", deliveryId: "original", sessionFile: "/fixture/session.jsonl" }),
    ], { producers: [], readJob: () => { throw Error("absent"); },
      readNative: () => [{ id: "same-native-event", at: ts, text: "A real order", scheduled: false }] })],
    then: ["one canonical order links both identities", rows => {
      expect(rows).toHaveLength(1); expect(rows[0].id).toBe("delivery:original");
      expect(rows[0].observationIds.sort()).toEqual(["delivery:original", "engine"]); expect(origin(rows[0])).toBe("human");
    }],
  });
  component("registered producer keys require the matching script hash and actual queue job", {
    when: ["a declared automation source matches its queue record", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-ask-producer-")), file = join(root, "timer.py"), config = join(root, "producers.json");
      writeFileSync(file, "producer-owned-fixture\n");
      writeFileSync(config, JSON.stringify([{ id: "timer", keyPrefix: "dispatch-checkpoint-", sourceFile: file,
        sourceSha256: createHash("sha256").update("producer-owned-fixture\n").digest("hex"), authority: "explicit fixture owner" }]));
      const row = ask("delivery:one", { source: "cli", deliveryId: "one" });
      const producers = readAskProducers(config);
      const resolved = resolveAskSourceEvidence([row], { producers, readJob: () => ({ id: "one", agentName: "api", pane: 0, text: row.verbatim, idempotencyKey: "dispatch-checkpoint-20261025T1100" }) });
      writeFileSync(file, "changed source\n");
      return { row: resolved[0], changed: readAskProducers(config) };
    }],
    then: ["the original is proved automated but changed code loses the registration", result => {
      expect(origin(result.row)).toBe("system"); expect(result.changed).toEqual([]);
    }],
  });
});
