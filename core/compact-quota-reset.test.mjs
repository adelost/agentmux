import { component, expect, feature, unit } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir } from "./claude-paths.mjs";
import { activeClaudeLimitReceipt, quotaRecoveryContinuation } from "./claude-quota-recovery.mjs";
import { assertClaudeQuotaAvailable } from "./claude-quota-target.mjs";
import { createClaudeQuotaCoordinator } from "./claude-quota-coordinator.mjs";
import { createContextMaintenance } from "./context-maintenance.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";
import { verifiedClaudeCompact } from "./verified-compact.mjs";
import { detectPaneStatus } from "../cli/format.mjs";
import { captureJsonlAppendCursor } from "./jsonl-append-cursor.mjs";
import { deliveryHead } from "./delivery-wake.mjs";

const resetAt = Date.parse("2026-10-17T12:40:00Z");
const banner = "You've hit your session limit · resets 2:40pm (Europe/Stockholm)";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-compact-reset-")), homeDir = join(root, "home");
  const repo = join(root, "repo"), dir = join(repo, ".agents", "0"), configPath = join(root, "agents.yaml");
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, "test:\n  dir: " + repo + "\n  panes:\n    - { cmd: claude }\n");
  const sessionId = "11111111-1111-4111-8111-111111111111", project = claudeProjectDir(dir, homeDir);
  mkdirSync(project, { recursive: true });
  const path = join(project, sessionId + ".jsonl"); writeFileSync(path, "");
  let clock = resetAt - 20 * 60_000, recovered = false, boundary = false;
  const data = {}, sent = [], echoes = new Set(), records = [];
  const state = { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => clock });
  const append = value => appendFileSync(path, JSON.stringify({ timestamp: new Date(clock).toISOString(), sessionId, ...value }) + "\n");
  const receipt = () => activeClaudeLimitReceipt(dir, { homeDir });
  const quotaOptions = () => ({ configPath, homeDir, queue });
  const agent = {
    paneProcessState: async () => ({ running: true }), isBusy: async () => false,
    getContext: async () => ({ tokens: 282740 }),
    promptTransportState: async () => ({ state: "empty-idle" }), dismissBlockingPrompt: async () => {},
    capturePromptEchoCursor: async () => captureJsonlAppendCursor("test", [path]),
    waitForPromptEcho: async (_name, _pane, text) => echoes.has(text),
    captureScreen: async () => "", capturePane: async () => "❯ ",
    sendOnly: async (_name, text, _pane, options = {}) => {
      if (recovered) assertClaudeQuotaAvailable("test", 0, { ...quotaOptions(), prompt: text });
      await options.onPasteStarted?.(); await options.onDrafted?.(); await options.onSubmitting?.(); await options.onSubmitted?.();
      sent.push(text);
      if (text.startsWith("/compact")) {
        if (!recovered) append({ type: "assistant", uuid: "22222222-2222-4222-8222-222222222222",
          message: { content: [{ type: "text", text: banner }] } });
        else { boundary = true; append({ type: "system", subtype: "compact_boundary" }); }
      } else { echoes.add(text); append({ type: "user", message: { content: text } }); }
    },
  };
  const deps = { agent, state, queue, configPath, now: () => clock,
    resolveTarget: () => ({ dir, engine: "claude" }), identityFor: () => ({ path, sessionId }),
    activityFor: () => resetAt - 79 * 60_000,
    quotaRecoveryFor: () => ({ receipt: receipt(), options: quotaOptions() }),
    compactFor: () => options => verifiedClaudeCompact({ ...options, now: () => clock,
      sleep: async ms => { clock += ms; }, pollAttempts: 2, pollMs: 1000,
      sendSlash: async (guarded, name, pane, command, hooks) => {
        await guarded.sendOnly(name, command, pane, { onSubmitting: hooks.onSubmitting, onSubmitted: hooks.onSubmitted });
        if (!recovered) clock += hooks.receiptTimeoutMs;
        return { delivered: recovered, via: "command-receipt" };
      }, hasBoundary: () => boundary }),
    coldBeforeDelivery: { limits: () => ({ tokens: 80000, idleMs: 50 * 60_000 }), mode: () => "on", background: () => null,
      record: row => records.push(row) },
  };
  const maintenance = createContextMaintenance(deps);
  const coordinator = createClaudeQuotaCoordinator({ queue, configPath, now: () => clock, readQuota: async () => ({
    ok: true, limits: [{ kind: "session", usedPercent: 5 }, { kind: "weekly_all", usedPercent: 20 }],
  }), lifecycle: { activeReceipt: receipt, restart: async () => { recovered = true; return { ok: true, sessionId }; } }, log: () => {} });
  return { root, path, state, agent, queue, sent, records, deps, maintenance, coordinator, receipt,
    quotaOptions, advanceReset: () => { clock = resetAt + 16000; }, setBusy: () => { agent.isBusy = async () => true; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
feature("quota reset settles failed maintenance before queued work", () => {
  unit("an explicit compact can settle a held automatic head without crossing any submit fence", {
    when: ["selecting the next job behind an uncompacted prompt", () => {
      const held = { id: "work", kind: "prompt", source: "cli", status: "pending", costHold: true };
      const compact = { id: "compact", kind: "slash", source: "amux:compact", status: "pending", text: "/compact" };
      return [deliveryHead([held, compact]).id, deliveryHead([{ ...held, submitFenceAt: 1 }, compact]).id];
    }], then: ["only an untouched cost hold yields to its requested maintenance", ids => expect(ids).toEqual(["compact", "work"])],
  });
  component("a submitted compact whose receipt waiter throws has a terminal failed record and releases its lease", {
    given: ["a compact which was submitted before its receipt wait failed", fixture],
    when: ["the receipt boundary throws", async ctx => {
      ctx.deps.compactFor = () => async options => {
        await options.agent.sendOnly("test", "/compact", 0);
        throw new Error("receipt wait timed out");
      };
      await createContextMaintenance(ctx.deps).run("test", 0, { cold: true });
      const writer = ctx.queue.acquireSessionLease("test", 0); const released = Boolean(writer); writer?.release();
      return { record: ctx.state.get("context_maintenance_by_pane_v1")["test:0"], released };
    }],
    then: ["the unresolved intent is honestly failed, not verified or stuck attempting", ({ record, released }) => {
      expect(record.status).toBe("FAILED"); expect(record.reason).toBe("receipt wait timed out"); expect(released).toBe(true);
    }], cleanup: ctx => ctx.cleanup(),
  });
  component("the completed exact-session restart authorizes the owner's ordinary prompt as well as its continuation", {
    given: ["a historical banner with no new work after a verified quota restart", fixture],
    when: ["the old pending human message reaches the existing quota guard", async ctx => {
      await ctx.maintenance.run("test", 0, { cold: true }); ctx.advanceReset(); await ctx.coordinator.tick();
      return assertClaudeQuotaAvailable("test", 0, { ...ctx.quotaOptions(), prompt: "An ordinary human message" });
    }],
    then: ["the old receipt does not block typing into that recovered session", receipt => expect(receipt.resetAt).toBe(resetAt)],
    cleanup: ctx => ctx.cleanup(),
  });
  component("a compact with no echo releases its writer and recovery delivers once after reset", {
    given: ["a large cold exact session whose compact hits a quota block without a command echo", fixture],
    when: ["letting the compact time out, resetting quota and draining the real broker", async ctx => {
      const first = await ctx.maintenance.run("test", 0, { cold: true });
      const writer = ctx.queue.acquireSessionLease("test", 0); const released = Boolean(writer); writer?.release();
      ctx.advanceReset(); await ctx.coordinator.tick();
      const broker = createDeliveryBroker({ agent: ctx.agent, queue: ctx.queue, now: ctx.deps.now,
        costAdmission: ctx.maintenance.beforeWork, notify: async () => {}, settleMs: 0 });
      await broker.kickTarget("test", 0); await broker.kickTarget("test", 0);
      return { first, released, jobs: ctx.queue.list("test", 0) };
    }],
    then: ["a terminal failed compact, released lease, one verified retry and one exact continuation need no force or manual input", ({ first, released, jobs }, ctx) => {
      expect(first.ok).toBe(false); expect(released).toBe(true);
      expect(jobs).toHaveLength(1); expect(jobs[0].status).toBe("acknowledged");
      expect(ctx.sent).toEqual(["/compact", "/compact", quotaRecoveryContinuation()]);
      expect(ctx.records.some(row => row.outcome !== "compacting")).toBe(true);
    }], cleanup: ctx => ctx.cleanup(),
  });
  component("an expired persisted attempting record from the limited window can recover too", {
    given: ["a bridge restart after a quota-blocked compact lost its final record", fixture],
    when: ["rebuilding the guard and resetting quota", async ctx => {
      await ctx.maintenance.run("test", 0, { cold: true });
      const record = ctx.state.get("context_maintenance_by_pane_v1")["test:0"];
      ctx.state.set("context_maintenance_by_pane_v1", { "test:0": { ...record, status: "ATTEMPTING" } });
      ctx.advanceReset(); await ctx.coordinator.tick();
      return createContextMaintenance(ctx.deps).beforeWork(ctx.queue.list("test", 0)[0]);
    }],
    then: ["the same-session recovery gets its required verified compact", (result, ctx) => {
      expect(result.ok).toBe(true); expect(ctx.sent).toEqual(["/compact", "/compact"]);
    }], cleanup: ctx => ctx.cleanup(),
  });
  component("no timeout or quota recovery proof authorizes a retry on a busy pane", {
    given: ["the failed quota compact on a pane which later starts working", fixture],
    when: ["resetting and seeing new live work", async ctx => {
      await ctx.maintenance.run("test", 0, { cold: true }); ctx.advanceReset(); await ctx.coordinator.tick(); ctx.setBusy();
      return ctx.maintenance.beforeWork(ctx.queue.list("test", 0)[0]);
    }],
    then: ["the guard holds with no second command", (result, ctx) => {
      expect(result.ok).toBe(false); expect(ctx.sent).toEqual(["/compact"]);
    }], cleanup: ctx => ctx.cleanup(),
  });
  unit("the old banner stops being limited only after its exact reset and an empty idle composer", {
    when: ["classifying the same screen before and after reset", () => {
      const receipt = { text: banner, resetAt };
      const screen = banner + "\n────\n❯ \n────\nbypass permissions on\n";
      return [
        detectPaneStatus(screen, { limitReceipt: receipt, now: resetAt - 1 }),
        detectPaneStatus(screen, { limitReceipt: receipt, now: resetAt + 16000 }),
        detectPaneStatus(screen.replace("❯ ", "❯ my draft"), { limitReceipt: receipt, now: resetAt + 16000 }),
        detectPaneStatus(screen + "esc to interrupt", { limitReceipt: receipt, now: resetAt + 16000 }),
        detectPaneStatus(screen, { now: resetAt + 16000 }),
      ];
    }],
    then: ["new quota, draft, work and unknown evidence remain guarded", statuses => expect(statuses).toEqual(["limited", "idle", "limited", "working", "limited"])],
  });
});
