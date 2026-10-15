import { feature, unit, component, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactBeforeSwitch, observeSwitchContext } from "./account-switch-compact.mjs";
import { accountSwitchPlan } from "../policies/account-switch-cost.mjs";

const target = { agent: { name: "lsrc" }, pane: { index: 0 } };
const runReturning = (row) => async () => ({ rows: [{ pane: "lsrc:0", ...row }] });

feature("the compact step of an account switch", () => {
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
