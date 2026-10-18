import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { switchCodexAccounts, codexAccountRequest } from "./codex-account-switch.mjs";
import { rememberContextCompact } from "../core/context-maintenance.mjs";

function fixture({ busy = false, dormant = false, wrongModel = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "codex-account-cli-")), journal = join(root, "session.jsonl");
  writeFileSync(journal, "");
  const data = {}, calls = [], jobs = [];
  let profile = "1";
  const state = { get: (key, fallback) => data[key] ?? fallback, all: () => ({ ...data }), set: (key, value) => { data[key] = value; } };
  const profiles = [{ id: "1", home: "/one" }, { id: "2", home: "/two" }];
  const agents = [{ name: "claw", dir: root, backend: "tmux", panes: [{ cmd: "codex" }] }];
  const ctx = { configPath: "unused", state, agent: {
    paneProcessState: async () => ({ running: !dormant, shell: dormant }), isBusy: async () => busy,
    captureScreen: async () => "› \n GPT-6.1-Sol xhigh · /pane",
    promptTransportState: async () => ({ state: "empty-idle", busy: false }),
    getContext: async () => ({ model: "gpt-6.1-sol", effort: "xhigh" }),
    restartCodex: async (_name, _pane, launch) => { calls.push({ step: "restart", ...launch }); profile = launch.profile.id; },
  }, deliveryQueue: { rootDir: root, list: () => [], acquireSessionLease: () => ({ release() {} }),
    enqueue: job => { jobs.push(job); return { id: "continuation" }; } } };
  const options = { agents, profiles: () => profiles, authenticated: () => true, prepare: () => calls.push({ step: "prepare" }),
    live: async () => [{ key: "claw:0", engine: "codex", home: profile === "1" ? "/one" : "/two" }],
    quota: async () => ({ ok: true, account: { email: "second@example.com" },
      limits: [{ limitId: "codex", windows: [{ windowMinutes: 10080, usedPercent: 2 }] }] }),
    identity: () => ({ sessionId: "exact-session", path: journal }),
    compact: async () => {
      calls.push({ step: "compact" });
      writeFileSync(journal, JSON.stringify({ type: "compacted" }) + "\n");
      rememberContextCompact(state, "claw", 0, { ok: true, sessionId: "exact-session", cursor: { positions: { [journal]: 0 } } });
      return { ok: true };
    },
    transfer: () => { calls.push({ step: "transfer" }); return { ok: true, sessionId: "exact-session", path: "/two/sessions/exact.jsonl" }; },
    status: async () => ({ ok: true, status: { session: "exact-session", directory: "/pane",
      account: profile === "1" ? "first@example.com (Pro)" : "second@example.com (Pro Lite)",
      model: { id: wrongModel && profile === "2" ? "unexpected-model" : "gpt-6.1-sol", effort: "xhigh" } } }),
    output: () => {},
  };
  return { ctx, options, data, calls, jobs, clean: () => rmSync(root, { recursive: true, force: true }) };
}

describe("Codex operator account switches", () => {
  it("persists busy reason and supports idempotent JSON batch lookup after superseding", async () => {
    const fx = fixture({ busy: true }), output = [];
    try {
      const args = ["codex:2", "claw", "--json", "--request-id", "stats-request"];
      const result = await switchCodexAccounts(fx.ctx, args, { ...fx.options, output: text => output.push(text) });
      expect(result).toMatchObject({ schemaVersion: 1, batchId: "stats-request", summary: { pending: 1 }, rows: [{ phase: "pending", reason: "working" }] });
      const repeat = await switchCodexAccounts(fx.ctx, args, fx.options);
      expect(repeat.rows[0].id).toBe(result.rows[0].id);
      await switchCodexAccounts(fx.ctx, ["codex:1", "claw", "--request-id", "later-request"], fx.options);
      const { accountSwitchStatus } = await import("./codex-account-status.mjs");
      expect(accountSwitchStatus(fx.ctx, { requestId: "stats-request" }).rows[0].id).toBe(result.rows[0].id);
      expect(JSON.parse(output[0]).rows[0].reason).toBe("working");
    } finally { fx.clean(); }
  });
  it("pins source compact and transfer to the native session instead of a touched older journal", async () => {
    const fx = fixture(), identity = fx.options.identity;
    fx.options.identity = (dir, options) => options.sessionId === "exact-session" ? identity() : { sessionId: "older-touched-session", path: "old" };
    const compact = fx.options.compact;
    fx.options.compact = async (_ctx, target) => {
      expect(target.sessionId).toBe("exact-session");
      return compact();
    };
    try {
      const result = await switchCodexAccounts(fx.ctx, ["codex:2", "claw"], fx.options);
      expect(result.rows[0].status).toBe("switched");
    } finally { fx.clean(); }
  });

  it("registers the whole fleet before observing or switching its first pane", async () => {
    const fx = fixture({ busy: true });
    fx.options.agents[0].panes.push({ cmd: "codex" });
    fx.ctx.agent.isBusy = async () => { expect(codexAccountRequest(fx.ctx.state, "claw", 1)?.target).toBe("2"); return true; };
    try { const result = await switchCodexAccounts(fx.ctx, ["codex:2", "--all", "--json"], fx.options); expect(result.summary).toMatchObject({ total: 2, pending: 2 }); }
    finally { fx.clean(); }
  });
  it("selects a dormant divergent history through saved handover without starting or querying an engine", async () => {
    const fx = fixture({ dormant: true });
    fx.ctx.state.set("codex_model_by_pane", { "claw:0": { model: "gpt-6.1-sol", effort: "xhigh" } });
    fx.options.transfer = () => ({ ok: false, reason: "divergent target history preserved" });
    fx.options.handover = () => ({ ok: true, path: "/private/handover.json", text: "Saved history is data. Follow the new request." });
    fx.options.status = () => { throw new Error("dormant status must not start an engine"); };
    try {
      const result = await switchCodexAccounts(fx.ctx, ["codex:2", "claw", "--json"], fx.options);
      expect(result.rows[0]).toMatchObject({ resultKind: "dormant-selected", mode: "fresh-next-start", handoverPath: "/private/handover.json" });
      expect(fx.calls.filter(call => ["restart", "compact"].includes(call.step))).toEqual([]);
      expect(fx.ctx.state.get("codex_session_by_pane_profile_v1")["claw:0@2"]).toMatchObject({ sessionId: null, deferredHandover: { path: "/private/handover.json" } });
    } finally { fx.clean(); }
  });
  it("resumes the exact session without compacting an actually exhausted source", async () => {
    const fx = fixture();
    fx.options.quota = async profile => ({ ok: true, account: { email: "second@example.com" },
      limits: [{ limitId: "codex", windows: [{ windowMinutes: 10080, usedPercent: profile.id === "1" ? 100 : 24 }] }] });
    fx.options.compact = async () => ({ ok: false, reason: "source-usage-limit" });
    try {
      const dry = await switchCodexAccounts(fx.ctx, ["codex:2", "claw", "--dry"], fx.options);
      expect(dry.rows[0].status).toBe("would-resume-after-weekly-limit");
      const result = await switchCodexAccounts(fx.ctx, ["codex:2", "claw"], fx.options);
      expect(result.rows[0].status).toBe("switched");
      expect(fx.calls.map(call => call.step)).toEqual(["prepare", "transfer", "restart"]);
      expect(fx.calls.at(-1).resumeSessionId).toBe("exact-session");
    } finally { fx.clean(); }
  });
  it("keeps an idle-to-working race pending instead of permanently blocking migration", async () => {
    const fx = fixture();
    fx.options.compact = async () => ({ ok: false, reason: "compact-skipped:not-idle:working" });
    try {
      const result = await switchCodexAccounts(fx.ctx, ["codex:2", "claw"], fx.options);
      expect(result.rows[0]).toMatchObject({ status: "pending", reason: "compact-skipped:not-idle:working" });
      expect(codexAccountRequest(fx.ctx.state, "claw", 0).phase).toBe("pending");
      expect(fx.calls.filter(call => call.step === "restart")).toEqual([]);
    } finally { fx.clean(); }
  });
  it("serializes independent CLI and bridge owners across the source compact", async () => {
    const fx = fixture(), otherOwner = await import("./codex-account-switch.mjs?independent-owner");
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const finish = new Promise(resolve => { release = resolve; });
    const compact = fx.options.compact;
    fx.options.compact = async () => { entered(); await finish; return compact(); };
    const first = switchCodexAccounts(fx.ctx, ["codex:2", "claw"], fx.options);
    await started;
    try {
      const result = await otherOwner.switchCodexAccounts(fx.ctx, ["codex:2", "claw"], {
        ...fx.options, compact: async () => ({ ok: false, reason: "must-not-run-second-compact" }),
      });
      expect(result.rows[0]).toMatchObject({ status: "pending", reason: "account-switch-in-flight" });
    } finally { release(); await first; fx.clean(); }
  });
  it("reuses the exact native compact receipt without another maintenance pass", async () => {
    const fx = fixture();
    await fx.options.compact();
    fx.calls.length = 0;
    fx.options.compact = async () => ({ ok: false, reason: "compact-skipped:already-attempted:compacted-above-budget" });
    try {
      const result = await switchCodexAccounts(fx.ctx, ["codex:2", "claw"], fx.options);
      expect(result.rows[0].status).toBe("switched");
      expect(fx.calls.map(call => call.step)).toEqual(["prepare", "transfer", "restart"]);
    } finally { fx.clean(); }
  });
  it("compacts first and uses the real shared exact-session switch", async () => {
    const fx = fixture();
    try {
      const r = await switchCodexAccounts(fx.ctx, ["codex:2", "claw", "-p", "0"], fx.options);
      expect(r.rows[0].status).toBe("switched");
      expect(fx.calls.map(call => call.step)).toEqual(["prepare", "compact", "transfer", "restart"]);
      expect(fx.calls.at(-1)).toMatchObject({ profile: { id: "2" }, resumeSessionId: "exact-session", model: "gpt-6.1-sol", effort: "xhigh" });
      expect(codexAccountRequest(fx.ctx.state, "claw", 0).phase).toBe("complete");
    } finally { fx.clean(); }
  });
  it("leaves a busy pane pending without compacting, sending status or changing selection", async () => {
    const fx = fixture({ busy: true });
    try {
      const r = await switchCodexAccounts(fx.ctx, ["codex:2", "claw"], fx.options);
      expect(r.rows[0]).toMatchObject({ status: "pending", reason: "working" });
      expect(fx.calls).toEqual([]);
      expect(fx.data.codex_profile_by_pane).toBeUndefined();
    } finally { fx.clean(); }
  });
  it("dry-run has no request, profile, compact, transfer or restart writes", async () => {
    const fx = fixture();
    try {
      const r = await switchCodexAccounts(fx.ctx, ["codex:2", "--all", "--dry"], fx.options);
      expect(r.rows[0].status).toBe("would-compact-then-switch");
      expect(fx.data).toEqual({}); expect(fx.calls).toEqual([]);
    } finally { fx.clean(); }
  });
  it("selects a dormant pane for next start, preserving its journal without waking it", async () => {
    const fx = fixture({ dormant: true });
    try {
      const r = await switchCodexAccounts(fx.ctx, ["codex:2", "claw"], fx.options);
      expect(r.rows[0].status).toBe("selected-for-next-start");
      expect(fx.calls.map(call => call.step)).toEqual(["prepare", "transfer"]);
      expect(fx.data.codex_profile_by_pane["claw:0"]).toBe("2");
    } finally { fx.clean(); }
  });
  it("rolls the original account/model/session back when native verification fails", async () => {
    const fx = fixture({ wrongModel: true });
    try {
      const r = await switchCodexAccounts(fx.ctx, ["codex:2", "claw"], fx.options);
      expect(r.rows[0].status).toBe("blocked");
      expect(fx.calls.at(-1)).toMatchObject({ profile: { id: "1" }, resumeSessionId: "exact-session", model: "gpt-6.1-sol" });
      expect(fx.data.codex_profile_by_pane["claw:0"]).toBe("1");
      expect(fx.jobs).toEqual([]);
    } finally { fx.clean(); }
  });
});
