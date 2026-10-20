import { feature, component, expect } from "bdd-vitest";
import { afterAll, beforeAll, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPauseCompact } from "./pause-compact.mjs";
import { createQuotaWindDownMover } from "./quota-wind-down-move.mjs";
import { createDeliveryBroker } from "../core/delivery-broker.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createSelfCompactStore } from "../core/self-compact.mjs";
import { createContextMaintenance } from "../core/context-maintenance.mjs";

function flow({ move = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-wind-down-flow-"));
  const session = join(root, "s1.jsonl"), configPath = join(root, "agents.yaml");
  writeFileSync(session, "{}\n");
  writeFileSync(configPath, `claw:\n  dir: ${root}\n  panes:\n    - { cmd: claude }\n`);
  let now = Date.parse("2026-10-20T10:07:10Z"), working = true, lastActivity = now;
  const records = {}, calls = [];
  const state = { get: (key, fallback) => records[key] ?? fallback, set: (key, value) => { records[key] = value; } };
  const identityFor = () => ({ sessionId: "s1", path: session });
  const profiles = [{ id: "1", key: "claude:1" }, { id: "2", key: "claude:2" }];
  let selected = profiles[0];
  const quota = () => ({ ok: true, provider: "claude", name: "Claude A", profile: profiles[1],
    observation: { observedAt: new Date(now - 1).toISOString() }, limits: [
      { kind: "session", usedPercent: 10, resetsAt: "2026-10-20T12:10:00Z" },
      { kind: "weekly_all", usedPercent: 40, resetsAt: "2026-10-23T12:10:00Z" }] });
  const agent = { paneProcessState: async () => ({ command: "claude", running: true }),
    isBusy: async () => working, promptTransportState: async () => ({ state: "empty-idle" }),
    getContext: async () => ({ tokens: 150_000 }) };
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => now });
  const broker = createDeliveryBroker({ agent, queue, now: () => now, log: () => {} });
  const selfRequests = createSelfCompactStore({ dir: join(root, "requests"), now: () => now });
  const contextMaintenance = createContextMaintenance({ agent, state, queue, selfRequests, now: () => now,
    resolveTarget: () => ({ engine: "claude", dir: root }), identityFor, activityFor: () => lastActivity,
    compactFor: () => async () => {
      calls.push("compact");
      appendFileSync(session, JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: new Date(now).toISOString() }) + "\n");
      return { ok: true, sessionId: "s1" };
    } });
  const parkFor = async () => ({ account: { name: "Claude S", key: "claude:1" },
    observedAt: Date.parse("2026-10-20T10:03:32Z"), accounts: [quota()],
    windows: [{ kind: "session", usedPercent: 94, resetsAt: "2026-10-20T11:10:00Z" }] });
  const lifecycle = { activeReceipt: () => null, profileFor: () => selected,
    selectProfile: (_name, _pane, profile) => { calls.push(`select:${profile.key}`); selected = profile; },
    restartAfterWindDown: async (_name, _pane, { sessionId, guard }) => {
      if (!await guard()) return { ok: false, reason: "changed" };
      calls.push(`restart:${sessionId}`); return { ok: true, sessionId };
    } };
  const mover = createQuotaWindDownMover({ agent, state, queue, configPath, lifecycle, identityFor,
    profiles: () => profiles, readTargetQuota: async () => quota(), now: () => now, accountFor: parkFor });
  const pause = createPauseCompact({ contextMaintenance, state, modes: { claude: "off" }, now: () => now,
    selfRequests, deliveryBroker: broker, parkFor, windDownMove: move, windDownMode: "on", moveAfterWindDown: mover,
    identityFor, journalCompactFor: () => null, limitReceiptFor: () => null, backgroundFor: { claude: () => null }, record: () => {} });
  return { calls, queue, selfRequests,
    poll: () => pause.consider({ agentConfig: { name: "claw" }, pane: 0, engine: "claude", paneDir: root,
      status: working ? "working" : "idle", inCopyMode: false, contextTokens: 150_000, lastActivityMs: lastActivity }),
    warningReceived: () => {
      for (const job of queue.list("claw", 0)) queue.update(job, { status: "acknowledged" });
      appendFileSync(session, JSON.stringify({ type: "user", message: { content: "synthetic wind-down warning" } }) + "\n");
    },
    turnEnds: () => { now += 60_000; lastActivity = now; working = false; },
    freshRoom: () => { now += 1000; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("quota wind-down composed path (component)", () => {
  // These cases exercise moves, which run only with wind-down on; the shipped default is dry (design §11).
  beforeAll(() => { vi.stubEnv("AMUX_QUOTA_WIND_DOWN", "on"); });
  afterAll(() => { vi.unstubAllEnvs(); });
  for (const move of [true, false]) {
    component(`notice, turn-end compact and ${move ? "verified move with continuation" : "disabled move"}`, {
      given: ["real poll, broker, request store, maintenance and coordinator; external process/quota boundaries doubled", () => flow({ move })],
      when: ["warning arrives, turn ends and a newer room reading arrives", async ctx => {
        await ctx.poll(); ctx.warningReceived(); ctx.turnEnds(); await ctx.poll(); ctx.freshRoom(); await ctx.poll();
      }],
      then: ["the compact precedes any selection and exact restart", (_result, ctx) => {
        try {
          expect(ctx.calls).toEqual(move ? ["compact", "select:claude:2", "restart:s1"] : ["compact"]);
          expect(ctx.selfRequests.list()).toEqual([]);
          const continuations = ctx.queue.list("claw", 0).filter(job => job.text.includes("· MOVED]"));
          expect(continuations).toHaveLength(move ? 1 : 0);
        } finally { ctx.cleanup(); }
      }],
    });
  }
});
