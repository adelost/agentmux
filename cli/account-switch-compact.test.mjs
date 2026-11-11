import { feature, unit, component, expect } from "bdd-vitest";
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactBeforeSwitch, observeSwitchContext } from "./account-switch-compact.mjs";
import { beginContextCompact, rememberContextCompact } from "../core/context-maintenance.mjs";
import { accountSwitchPlan } from "../policies/account-switch-cost.mjs";

const target = { agent: { name: "lsrc" }, pane: { index: 0 }, engine: "claude" };
const runReturning = (row) => async () => ({ rows: [{ pane: "lsrc:0", ...row }] });

feature("the compact step of an account switch", () => {
  for (const systemNotification of [true, false]) {
    component(`a ${systemNotification ? "transcript-only system" : "human"} notification after compact`, {
      given: ["an idle session with one notification and no model output", () => {
        const root = mkdtempSync(join(tmpdir(), "amux-switch-notification-"));
        const path = join(root, "session.jsonl"), sessionId = "s";
        const events = [
          { type: "system", subtype: "compact_boundary", sessionId, timestamp: "2026-10-31T05:02:31Z" },
          { type: "user", sessionId, isCompactSummary: true, message: { content: "summary" } },
          { type: "user", sessionId, ...(systemNotification ? { origin: { kind: "task-notification" },
            promptSource: "system", queueTranscriptOnly: true } : {}),
            message: { content: "<task-notification>stopped</task-notification>" } },
        ];
        writeFileSync(path, events.map(event => JSON.stringify(event)).join("\n") + "\n");
        return { root, facts: { engine: "claude", backend: "tmux", running: true, sessionId, sessionPath: path,
          status: "idle", composerEmpty: true, queued: 0, tokens: null, idleMs: 60_000 } };
      }],
      when: ["the account switch reads the unchanged epoch", async ({ facts }) => {
        const context = await observeSwitchContext({ deliveryQueue: {} }, { agent: {}, agentName: "test", pane: 0 }, {
          discover: async () => [{ engine: "claude", agent: {}, pane: { index: 0 } }], observe: async () => facts,
        });
        return accountSwitchPlan({ mode: "running", facts: context.facts, compacted: context.compacted });
      }],
      then: ["only a verified transcript-only system notification keeps the epoch empty", (plan, fx) => {
        try { expect(plan.action).toBe(systemNotification ? "RESTART" : "HOLD"); }
        finally { rmSync(fx.root, { recursive: true, force: true }); }
      }],
    });
  }
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
  component("a completed pause compact also satisfies a switch with unknown after size", {
    given: ["the shared receipt and its exact journal boundary", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-switch-pause-")), path = join(root, "s.jsonl");
      writeFileSync(path, "");
      const data = {}, state = { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => data[key] = value };
      const intent = beginContextCompact(state, "test", 0, { sessionId: "s", path });
      appendFileSync(path, JSON.stringify({ type: "system", subtype: "compact_boundary", sessionId: "s" }) + "\n");
      rememberContextCompact(state, "test", 0, { ...intent, ok: true, compactBoundary: true });
      return { root, state, facts: { engine: "claude", backend: "tmux", running: true, sessionId: "s", sessionPath: path,
        status: "idle", composerEmpty: true, queued: 0, tokens: null, idleMs: 60_000 } };
    }],
    when: ["the switch reads the pause receipt", fx => observeSwitchContext({ state: fx.state, deliveryQueue: {} },
      { agent: {}, agentName: "test", pane: 0 }, { discover: async () => [{ engine: "claude", agent: {}, pane: { index: 0 } }],
        observe: async () => fx.facts })],
    then: ["the existing compact is used without inventing a size", (result, fx) => {
      try { expect(result.compacted).toBe(true); expect(result.facts.tokens).toBeNull(); }
      finally { rmSync(fx.root, { recursive: true, force: true }); }
    }],
  });
  for (const afterTokens of [null, 116_000]) {
    unit(`a verified switch compact accepts its real after size ${afterTokens}`, {
      when: ["the exact boundary is verified", () => compactBeforeSwitch({ deliveryQueue: {} }, target,
        { run: runReturning({ status: afterTokens === null ? "compacted-unmeasured" : "compacted-above-budget", afterTokens }) })],
      then: ["the switch proceeds without another size-chasing attempt", result => expect(result).toMatchObject({ ok: true, afterTokens })],
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

  unit("a compact skipped before its send says nothing was sent, so the switch may try again", {
    when: ["another delivery holds the pane's lease", () =>
      compactBeforeSwitch({ deliveryQueue: {} }, target, { run: runReturning({ status: "skipped", reason: "delivery-lease-busy" }) })],
    then: ["the result carries the proof", (result) =>
      expect(result).toEqual({ ok: false, sent: false, reason: "compact-skipped:delivery-lease-busy" })],
  });
});
