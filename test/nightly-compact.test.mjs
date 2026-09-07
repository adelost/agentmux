import { feature, unit, component, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nightlyCompactPolicy, nightlyCompactDecision, nightlyCompactOutcome, compactAccessBlocker } from "../core/nightly-compact.mjs";
import { runNightlyCompact } from "../cli/nightly-compact.mjs";
import { cmdDream } from "../cli/dream.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { parseConfig, generateAgentsYaml } from "../sync.mjs";

const now = () => Date.parse("2026-09-07T02:00:00Z");
const facts = () => ({ engine: "claude", backend: "tmux", running: true,
  sessionId: "same-session", sessionPath: "/exact.jsonl", status: "idle",
  composerEmpty: true, queued: 0, tokens: 227_000, percent: 28, idleMs: 31 * 60_000,
  activity: now() - 31 * 60_000, model: "Fable 5.1", effort: "xhigh" });
const policy = nightlyCompactPolicy();
const target = { agent: { name: "claw", backend: "tmux" }, pane: { index: 4 }, engine: "claude", paneDir: "/pane" };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-night-budget-"));
  let calls = 0;
  let observed = facts();
  const queue = createDeliveryQueue({ rootDir: join(root, "queue") });
  const ctx = { agent: { sendOnly: async () => { calls++; } } };
  const deps = { path: join(root, "night.json"), targets: [target], runtimeConfig: {}, queue, now,
    observe: async () => ({ ...observed }), sleep: async () => {}, mirror: async () => {},
    compact: async ({ agent }) => {
      await agent.sendOnly("claw", "/compact", 4);
      observed = { ...observed, tokens: 23_000 };
      return { ok: true, sessionId: "same-session", compactBoundary: true };
    },
  };
  return { root, ctx, deps, calls: () => calls, change: (value) => { observed = { ...observed, ...value }; },
    clean: () => rmSync(root, { recursive: true, force: true }) };
}

feature("nightly context budget", () => {
  unit("selects 227k at 28 percent and 100k at 10 percent without changing the daytime rule", {
    when: ["checking absolute context tokens", () => [facts(), { ...facts(), tokens: 100_000, percent: 10 }].map((item) => nightlyCompactDecision(item, policy))],
    then: ["both are eligible", (result) => expect(result).toEqual([null, null])],
  });
  unit("keeps active, uncertain, unsupported and already attempted sessions untouched", {
    when: ["checking all unsafe axes", () => [
      { tokens: 80_000 }, { tokens: null }, { idleMs: 29 * 60_000 }, { idleMs: null },
      { status: "working" }, { status: "unknown" }, { status: "permission" },
      { composerEmpty: false }, { queued: 1 }, { queued: null }, { running: false },
      { sessionId: null }, { backend: "native" }, { engine: "kimi" },
      { model: "Haiku 4.5" }, { effort: "low" }, { effort: null },
    ].map((delta) => nightlyCompactDecision({ ...facts(), ...delta }, policy))],
    then: ["none authorize a model call", (result) => expect(result.every(Boolean)).toBe(true)],
  });
  unit("does not equate a boundary, a no-op or a stale session with the budget", {
    when: ["checking post-compact outcomes", () => {
      const receipt = { ok: true, compactBoundary: true, sessionId: facts().sessionId };
      return [
        nightlyCompactOutcome(receipt, facts(), { ...facts(), tokens: 120_000 }, 80_000).status,
        nightlyCompactOutcome(receipt, facts(), { ...facts(), tokens: null }, 80_000).status,
        nightlyCompactOutcome({ ok: true }, facts(), { ...facts(), tokens: 100 }, 80_000).status,
        nightlyCompactOutcome(receipt, facts(), { ...facts(), sessionId: "other", tokens: 100 }, 80_000).status,
      ];
    }],
    then: ["all remain explicitly unresolved", (result) => expect(result).toEqual(["compacted-above-budget", "compacted-unmeasured", "failed", "failed"])],
  });
  unit("keeps the configuration through regeneration and rejects invalid units", {
    when: ["parsing the user-owned source", () => {
      const source = "dream:\n  agent: claw\n  pane: 0\n  compact: {maxTokens: 80000, idleMinutes: 30}\nagents:\n  claw: {dir: /repo, panes: 1}\n";
      const parsed = parseConfig(source);
      return { parsed, yaml: generateAgentsYaml(parsed.agents, new Map(), new Map(), null, null, parsed.dream) };
    }],
    then: ["the policy remains data, not a dropped generator field", ({ parsed, yaml }) => {
      expect(parsed.dream.compact).toEqual(policy);
      expect(yaml).toContain("maxTokens: 80000");
      expect(() => nightlyCompactPolicy({ maxBytes: 80000 })).toThrow();
      expect(nightlyCompactPolicy(false).enabled).toBe(false);
    }],
  });
  unit("attributes a provider refusal to the last visible turn, not older scrollback", {
    when: ["reading current and superseded failures", () => {
      const failure = "Your organization has disabled Claude subscription access for Claude Code";
      return [compactAccessBlocker(`❯ /compact\n${failure}\n❯ `), compactAccessBlocker(`${failure}\n❯ new task\n● finished\n❯ `)];
    }],
    then: ["only the current refusal blocks", (result) => expect(result).toEqual(["claude-subscription-access-disabled", null])],
  });
  component("dry-run previews without typing, acquiring a lease or writing receipts", {
    when: ["previewing the actual runner", async () => {
      const fx = fixture();
      try {
        const before = readdirSync(fx.root);
        fx.deps.queue.acquireSessionLease = () => { throw new Error("dry-run leased"); };
        const result = await runNightlyCompact(fx.ctx, { dry: true }, fx.deps);
        return { rows: result.rows, calls: fx.calls(), before, after: readdirSync(fx.root) };
      } finally { fx.clean(); }
    }],
    then: ["one candidate and zero mutations", (result) => {
      expect(result.rows[0].status).toBe("eligible"); expect(result.calls).toBe(0); expect(result.after).toEqual(result.before);
    }],
  });
  component("runs through the shared lease and persists one exact result per night", {
    when: ["running twice with a later large context", async () => {
      const fx = fixture();
      try {
        const first = await runNightlyCompact(fx.ctx, {}, fx.deps);
        fx.change({ tokens: 150_000 });
        const second = await runNightlyCompact(fx.ctx, {}, fx.deps);
        return { first, second, calls: fx.calls(), stored: JSON.parse(readFileSync(join(fx.deps.path, "claw%3A4.json"), "utf8")) };
      } finally { fx.clean(); }
    }],
    then: ["a real reduction is saved and a second invocation never calls the model", ({ first, second, calls, stored }) => {
      expect(first.rows[0]).toMatchObject({ status: "within-budget", beforeTokens: 227_000, afterTokens: 23_000 });
      expect(second.rows[0].reason).toBe("already-attempted:within-budget");
      expect(calls).toBe(1); expect(stored.panes["claw:4"].sessionId).toBe("same-session");
    }],
  });
  for (const [name, delta] of [["new enqueue", { queued: 1 }], ["human draft", { composerEmpty: false }], ["changed session", { sessionId: "new" }]]) {
    component(`aborts on ${name} after discovery`, {
      when: ["the final pre-submit check observes a race", async () => {
        const fx = fixture();
        try {
          fx.deps.mirror = async () => { fx.change(delta); };
          const result = await runNightlyCompact(fx.ctx, {}, fx.deps);
          return { result, calls: fx.calls() };
        } finally { fx.clean(); }
      }],
      then: ["no slash is typed", ({ result, calls }) => { expect(calls).toBe(0); expect(result.rows[0].status).toBe("failed"); }],
    });
  }
  component("ambiguous failed compact is durable and never blindly repeated", {
    when: ["the engine call fails after intent was stored", async () => {
      const fx = fixture();
      try {
        fx.deps.compact = async () => { throw new Error("connection lost after submit"); };
        await runNightlyCompact(fx.ctx, {}, fx.deps);
        const result = await runNightlyCompact(fx.ctx, {}, fx.deps);
        return result.rows[0];
      } finally { fx.clean(); }
    }],
    then: ["the receipt fence blocks the second attempt", (row) => expect(row.reason).toBe("already-attempted:failed")],
  });
  component("Dream still invokes nightly maintenance after curator failure", {
    when: ["a scheduled digest cannot compact its curator", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-night-"));
      const oldHome = process.env.HOME, oldJanitor = process.env.AMUX_JANITOR_ENABLED;
      process.env.HOME = root; process.env.AMUX_JANITOR_ENABLED = "false";
      let nightly = 0, failed = false;
      try {
        await cmdDream({ configPath: "missing", agent: { ensureReady: async () => {} } }, { workspace: root }, {
          agents: [], owner: { agent: "claw", pane: 1, engine: "claude", paneDir: "/unused" },
          readReceipts: () => ({ schemaVersion: 1, panes: {} }),
          collectSources: () => ({ sources: [{ agent: "claw", pane: 1, engine: "claude", turns: 1, activityCursor: "2026-09-07T01:00:00Z", entries: [{ timestamp: "2026-09-07T01:00:00Z", userPrompt: "fix it", items: [{ type: "text", content: "done" }] }] }], unreadable: [] }),
          getStatus: async () => "idle", getContext: () => ({ model: "Fable 5.1", effort: "xhigh" }),
          compactClaude: async () => ({ ok: false, reason: "claude-subscription-access-disabled" }),
          nightlyCompact: async () => { nightly++; },
        });
      } catch (error) { failed = error.message.includes("claude-subscription-access-disabled"); }
      finally {
        process.env.HOME = oldHome;
        if (oldJanitor === undefined) delete process.env.AMUX_JANITOR_ENABLED; else process.env.AMUX_JANITOR_ENABLED = oldJanitor;
        rmSync(root, { recursive: true, force: true });
      }
      return { nightly, failed };
    }],
    then: ["the failure stays visible but does not suppress the independent budget pass", (result) => expect(result).toEqual({ nightly: 1, failed: true })],
  });
});
