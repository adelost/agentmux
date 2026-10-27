import { feature, unit, component, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactBeforeSwitch, observeSwitchContext } from "./account-switch-compact.mjs";
import { accountSwitchPlan } from "../policies/account-switch-cost.mjs";

const target = { agent: { name: "lsrc" }, pane: { index: 0 } };
const runReturning = (row) => async () => ({ rows: [{ pane: "lsrc:0", ...row }] });

feature("the compact step of an account switch", () => {
  // lsrc:0 and skyvw:0, 27 Oct: 61 and 1 prompts held by Claude V's quota floor kept both large contexts from
  // compacting, so rotate could never move them to an account with room.
  const floorHeld = { status: "pending", costHold: true, attempts: 41,
    lastReason: "wake-refused:quota-floor: Claude V has 1 % of its week left (floor 3 %)" };
  for (const [name, jobs, refusal] of [
    ["prompts held only by the quota floor do not block it", [floorHeld, { status: "pending" }], null],
    ["a prompt the floor does not hold still blocks it", [{ status: "pending" }], "delivery-pending-or-unknown"],
  ]) {
    component(`the switch compact: ${name}`, {
      given: ["a large idle Claude pane and its queue", () => ({ jobs, facts: { engine: "claude", backend: "tmux",
        running: true, sessionId: "s", sessionPath: "/nonexistent/s.jsonl", status: "idle", composerEmpty: true,
        queued: jobs.length, model: "opus", effort: "high", tokens: 380_000, idleMs: 3_600_000 } })],
      when: ["the rotation observes the pane", ({ jobs, facts }) => observeSwitchContext(
        { deliveryQueue: { list: () => jobs }, state: {} }, { agent: {}, agentName: "lsrc", pane: 0 },
        { discover: async () => [{ engine: "claude", agent: {}, pane: { index: 0 } }], observe: async () => facts,
          policy: { maxTokens: 150_000 } })],
      then: ["only live delivery refuses the compact", (context) => expect(context.compactRefusal).toBe(refusal)],
    });
  }
  component("the compact run before a switch sees the same live count", {
    given: ["a pane whose only open jobs the quota floor holds", () => ({ jobs: [floorHeld, { status: "pending" }] })],
    when: ["the switch runs its compact", async ({ jobs }) => {
      let seen, pending;
      await compactBeforeSwitch({ deliveryQueue: { list: () => jobs } },
        { agent: { name: "lsrc" }, pane: { index: 0 }, engine: "claude" },
        { run: async (_ctx, _flags, deps) => {
          seen = await deps.observe({}, { agent: { name: "lsrc" }, pane: { index: 0 } }, { queue: deps.queue });
          pending = await deps.livePending("lsrc", 0);
          return { rows: [] };
        }, observeNightly: async () => ({ queued: jobs.length }) });
      return { seen, pending };
    }],
    then: ["held prompts are not live delivery, before the run or at its last check before Enter",
      ({ seen, pending }) => { expect(seen.queued).toBe(0); expect(pending).toBe(false); }],
  });
  for (const newWork of [false, true]) {
    component(`a manual compact with missing size ${newWork ? "cannot hide new work" : "can restart an idle pane"}`, {
      given: ["a real compact boundary, summary and local command receipts without a new usage block", () => {
        const root = mkdtempSync(join(tmpdir(), "amux-switch-manual-")), sessionId = "manual-session";
        const path = join(root, "session.jsonl");
        const events = [
          { type: "system", subtype: "compact_boundary", sessionId, timestamp: "2026-10-15T12:14:49.504Z" },
          { type: "user", isCompactSummary: true, sessionId, message: { content: "summary" } },
          { type: "user", sessionId, message: { content: "<command-name>/compact</command-name>" } },
          ...(newWork ? [{ type: "user", sessionId, message: { content: "new task" } }] : []),
        ];
        writeFileSync(path, events.map(event => JSON.stringify(event)).join("\n") + "\n");
        const facts = { engine: "claude", backend: "tmux", running: true, sessionId, sessionPath: path,
          status: "idle", composerEmpty: true, queued: 0, tokens: null, idleMs: 60_000 };
        return { root, facts };
      }],
      when: ["the rotation observes that exact idle session", async ({ facts }) => {
        const context = await observeSwitchContext({ deliveryQueue: {} }, { agent: {}, agentName: "test", pane: 0 }, {
          discover: async () => [{ engine: "claude", agent: {}, pane: { index: 0 } }], observe: async () => facts,
        });
        return accountSwitchPlan({ mode: "running", facts: context.facts, compacted: context.compacted });
      }],
      then: ["only the unchanged compact epoch authorizes restart", (plan, fx) => {
        try { expect(plan.action).toBe(newWork ? "HOLD" : "RESTART"); }
        finally { rmSync(fx.root, { recursive: true, force: true }); }
      }],
    });
  }
  unit("a session with nothing to compact may switch: there is no cache to lose", {
    when: ["Claude answered Not enough messages to compact", () =>
      compactBeforeSwitch({ deliveryQueue: {} }, target, { run: runReturning({ status: "nothing-to-compact" }) })],
    then: ["the pane may move", (result) => expect(result).toMatchObject({ ok: true, status: "nothing-to-compact" })],
  });

  unit("an unverified compact still keeps the pane on its source", {
    when: ["the boundary never came", () =>
      compactBeforeSwitch({ deliveryQueue: {} }, target, { run: runReturning({ status: "failed", reason: "compact-boundary-missing" }) })],
    then: ["the reason is kept", (result) => expect(result).toEqual({ ok: false, reason: "compact-failed:compact-boundary-missing" })],
  });
});
