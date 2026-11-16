import { component, expect, feature } from "bdd-vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { overrideFailedCompact } from "../core/compact-receipts.mjs";
import { cmdCompact } from "./compact.mjs";
import { createState } from "../core/state.mjs";
import { rememberContextCompact } from "../core/context-maintenance.mjs";
import { captureJsonlAppendCursor } from "../core/jsonl-append-cursor.mjs";

const sent = [];
const seenAtEnqueue = [];
const journals = {};
const reading = { tokens: 106_838 };
// Row 214 (the owner's decision of 16 Nov 2026) holds a pane that compacts other panes to 400k, so each case names its
// caller: these suites run inside agent panes, where TMUX is set.
const PERSON = { detect: () => null, env: {} };
const WORKER = { detect: () => ({ key: "lsrc:7", session: "lsrc", pane: 7 }), env: {} };
vi.mock("./tmux.mjs", () => ({ hasSession: async () => true,
  listPanes: async () => [{ index: 1, command: "claude" }, { index: 2, command: "claude" }],
  sendToPane: async (ctx, agent, pane, text) => {
    seenAtEnqueue.push(ctx.state.get("context_maintenance_by_pane_v1", {})[`${agent}:${pane}`]?.status);
    sent.push(`${agent}:${pane} ${text}`); return { delivered: true };
  } }));
// Claude keeps reporting the pre-compact size until its next turn, so both panes read 107k.
vi.mock("./inspect-pane.mjs", () => ({ dialectFor: () => "claude",
  inspectPane: async () => ({ status: "idle", context: { tokens: reading.tokens, percent: 10 } }) }));
vi.mock("../core/native-session-identity.mjs", () => ({
  latestPaneSessionIdentity: (_engine, dir) => journals[dir] || null }));

const row = content => `${JSON.stringify({ type: "user", message: { content } })}\n`;

/** Two idle api panes with work; api:2 then gets a verified compact followed by `afterCompact`. */
function fleetWithCompactedPane2(afterCompact, tokens = 106_838) {
  reading.tokens = tokens;
  sent.length = 0;
  seenAtEnqueue.length = 0;
  const root = mkdtempSync(join(tmpdir(), "amux-bulk-fence-"));
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, `api:\n  dir: ${root}\n  panes:\n${"    - cmd: claude\n".repeat(3)}`);
  for (const pane of [1, 2]) {
    const path = join(root, `session-${pane}.jsonl`);
    writeFileSync(path, row("Men är det bara disciplin?"));
    journals[join(root, ".agents", String(pane))] = { sessionId: `session-${pane}`, path };
  }
  const state = createState(join(root, "state.json"));
  const pane2 = journals[join(root, ".agents", "2")];
  rememberContextCompact(state, "api", 2, { ok: true, sessionId: pane2.sessionId,
    cursor: captureJsonlAppendCursor("context-maintenance-v1", [pane2.path]) });
  appendFileSync(pane2.path, row(afterCompact));
  const deliveryQueue = { acquireSessionLease: () => ({ release() {} }) };
  return { root, ctx: { configPath, state, deliveryQueue } };
}

feature("bulk compact skips a context compacted with no work since", () => {
  for (const status of ["FAILED", "UNVERIFIED", "UNKNOWN", "ATTEMPTING"]) {
    component(`an emergency override preserves exact-session audit for ${status}`, {
      given: ["an untouched failed generation", () => {
        const fx = fleetWithCompactedPane2("/compact"), identity = journals[join(fx.root, ".agents", "2")];
        const all = fx.ctx.state.get("context_maintenance_by_pane_v1");
        fx.ctx.state.set("context_maintenance_by_pane_v1", { ...all, "api:2": { ...all["api:2"], status, at: 123 } });
        return { ...fx, identity };
      }],
      when: ["the authorized operator names a reason", fx => {
        const run = () => overrideFailedCompact(fx.ctx.state, "api:2", fx.identity,
          { actor: "sandman:0", reason: "Explicit recovery after verified source failure", at: 456 });
        if (["FAILED", "UNVERIFIED"].includes(status)) run(); else expect(run).toThrow("not FAILED/UNVERIFIED");
      }],
      then: ["unknown or in-flight stays fenced and an accepted override survives the next receipt", (_, fx) => {
        let receipt = fx.ctx.state.get("context_maintenance_by_pane_v1")["api:2"];
        if (!["FAILED", "UNVERIFIED"].includes(status)) { expect(receipt.status).toBe(status); return; }
        expect(receipt).toMatchObject({ status: "NOT_SENT", overrides: [{ actor: "sandman:0", at: 456,
          sessionId: fx.identity.sessionId, priorStatus: status, priorAt: 123 }] });
        rememberContextCompact(fx.ctx.state, "api", 2, { ok: true, sessionId: fx.identity.sessionId, cursor: receipt.cursor });
        receipt = fx.ctx.state.get("context_maintenance_by_pane_v1")["api:2"];
        expect(receipt.status).toBe("VERIFIED"); expect(receipt.overrides).toHaveLength(1);
      }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
    });
  }
  component("sandman can request one audited emergency compact through the targeted CLI", {
    given: ["a failed exact session at 450k", () => {
      const fx = fleetWithCompactedPane2("/compact", 450_000), all = fx.ctx.state.get("context_maintenance_by_pane_v1");
      fx.ctx.state.set("context_maintenance_by_pane_v1", { ...all, "api:2": { ...all["api:2"], status: "FAILED" } });
      return fx;
    }],
    when: ["the authorized caller invokes the emergency path", fx => cmdCompact(fx.ctx,
      { p: 2, "override-failed": "Operator accepted retry after checking the refused call" }, ["api"],
      { detect: () => ({ key: "sandman:0", session: "sandman", pane: 0 }) })],
    then: ["one slash command and its audit are durable", (_, fx) => {
      expect(sent).toEqual(["api:2 /compact"]);
      expect(fx.ctx.state.get("context_maintenance_by_pane_v1")["api:2"]).toMatchObject({
        status: "ATTEMPTING", sessionId: "session-2", overrides: [{ actor: "sandman:0", sessionId: "session-2" }] });
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  component("a worker cannot invoke the emergency override", {
    when: ["a worker calls the CLI", () => cmdCompact({}, { p: 2, "override-failed": "retry" }, ["api"],
      { detect: () => ({ key: "lsrc:7", session: "lsrc", pane: 7 }) }).then(() => null, error => error.message)],
    then: ["the caller is refused before reading or changing a receipt", result => expect(result).toContain("only for a human or sandman:0")],
  });
  component("a queued manual compact fences another bulk pass", {
    given: ["a pane eligible for one compact and a second pane already compacted", () => fleetWithCompactedPane2("/compact")],
    when: ["the operator invokes bulk compact twice before a native boundary arrives", async fx => {
      await cmdCompact(fx.ctx, {}, [], PERSON); await cmdCompact(fx.ctx, {}, [], PERSON);
    }],
    then: ["the shared attempting receipt prevents a duplicate command", () => expect(sent).toEqual(["api:1 /compact"])],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  component("api:2, compacted on 10-11 and idle since, is not compacted again on 10-12", {
    given: ["two idle panes at 107k; api:2's journal has only the /compact after its verified compact",
      () => fleetWithCompactedPane2("/compact")],
    when: ["an operator runs amux compact over the fleet", fx => cmdCompact(fx.ctx, {}, [], PERSON)],
    then: ["only the pane with uncompacted work gets /compact and its intent uses the shared store", (_, fx) => {
      expect(sent).toEqual(["api:1 /compact"]);
      expect(seenAtEnqueue).toEqual(["ATTEMPTING"]);
      expect(fx.ctx.state.get("context_maintenance_by_pane_v1")["api:1"]).toMatchObject({ status: "ATTEMPTING", sessionId: "session-1" });
    }],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });

  component("new work after the compact makes the pane eligible again", {
    given: ["api:2 compacted, then given a new question", () => fleetWithCompactedPane2("Har han semester?")],
    when: ["an operator runs amux compact over the fleet", fx => cmdCompact(fx.ctx, {}, [], PERSON)],
    then: ["both panes get /compact", () => expect(sent).toEqual(["api:1 /compact", "api:2 /compact"])],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});

// Row 214, the owner's decision of 16 Nov 2026: a pane at work is never compacted under 400k, and a neighbour cannot
// know that a pane rests. A person's own shell keeps 80k and a free --min-tokens.
feature("a pane compacts another pane only above 400k; a person stays free", () => {
  const TMUX_SHELL = { detect: () => null, env: { TMUX: "/tmp/tmux-1000/default,1,0" } };
  const outcome = promise => promise.then(result => result ?? null, error => error.message);
  for (const [label, tokens, caller, flags, expected] of [
    ["a worker's target at 300k is left alone", 300_000, WORKER, { p: 1 }, "at-work"],
    ["a worker's forced target at exactly 400 000 is left alone", 400_000, WORKER, { p: 1, force: true }, "at-work"],
    ["a worker's target at 400 001 is compacted", 400_001, WORKER, { p: 1 }, ["api:1 /compact"]],
    ["a worker's target at 450k is compacted", 450_000, WORKER, { p: 1 }, ["api:1 /compact"]],
    ["a person's target at 100k is compacted as before", 100_000, PERSON, { p: 1 }, ["api:1 /compact"]],
    ["a shell inside tmux without a pane address counts as a pane", 300_000, TMUX_SHELL, { p: 1 }, "at-work"],
  ]) component(`targeted: ${label}`, {
    given: [`api:1 idle at ${tokens} tokens`, () => fleetWithCompactedPane2("/compact", tokens)],
    when: ["the caller targets api:1", fx => outcome(cmdCompact(fx.ctx, flags, ["api"], caller))],
    then: ["under 400k a pane's compact is not sent, and the answer says it is no error", result => {
      if (Array.isArray(expected)) { expect(result).toBeNull(); return expect(sent).toEqual(expected); }
      expect(result).toMatchObject({ ok: false, cell: expected });
      expect(result.detail).toContain(`${tokens} tokens is not above 400000. This is not an error`);
      expect(result.detail).toContain("Claude after 50 min from 80k, Codex after 25 min from 150k"); expect(sent).toEqual([]);
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  component("sandman's emergency override is not sent to a pane under 400k", {
    given: ["a failed exact session at 107k", () => {
      const fx = fleetWithCompactedPane2("/compact"), all = fx.ctx.state.get("context_maintenance_by_pane_v1");
      fx.ctx.state.set("context_maintenance_by_pane_v1", { ...all, "api:2": { ...all["api:2"], status: "FAILED" } });
      return fx;
    }],
    when: ["sandman:0 invokes the emergency path", fx => outcome(cmdCompact(fx.ctx, { p: 2, "override-failed": "retry after a refused call" }, ["api"],
      { detect: () => ({ key: "sandman:0", session: "sandman", pane: 0 }), env: {} }))],
    then: ["nothing is sent and the failed receipt stays", (result, fx) => {
      expect(result).toMatchObject({ ok: false, cell: "at-work" }); expect(sent).toEqual([]);
      expect(fx.ctx.state.get("context_maintenance_by_pane_v1")["api:2"].status).toBe("FAILED");
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  for (const [label, tokens, caller, flags, expected] of [
    ["a worker's bulk pass leaves panes at 300k alone", 300_000, WORKER, {}, []],
    ["a worker's bulk pass leaves panes at exactly 400 000 alone", 400_000, WORKER, {}, []],
    ["a worker's bulk pass compacts panes at 450k", 450_000, WORKER, {}, ["api:1 /compact"]],
    ["a worker's --min-tokens under 400k is rejected", 450_000, WORKER, { "min-tokens": 100_000 }, "--min-tokens 100000 is under 400000"],
    ["a worker's --min-tokens above 400k is kept", 450_000, WORKER, { "min-tokens": 500_000 }, []],
    ["a person's bulk pass compacts panes at 100k as before", 100_000, PERSON, {}, ["api:1 /compact"]],
    ["a person's --min-tokens under 80k is kept", 60_000, PERSON, { "min-tokens": 50_000 }, ["api:1 /compact"]],
  ]) component(`bulk: ${label}`, {
    given: [`two idle panes at ${tokens} tokens, api:2 compacted with no work since`, () => fleetWithCompactedPane2("/compact", tokens)],
    when: ["the caller runs amux compact over the fleet", fx => outcome(cmdCompact(fx.ctx, flags, [], caller))],
    then: ["a pane's pass starts above 400k and a person's at 80k or their own number", refusal => {
      if (Array.isArray(expected)) { expect(refusal).toBeNull(); return expect(sent).toEqual(expected); }
      expect(refusal).toContain(expected); expect(sent).toEqual([]);
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});
