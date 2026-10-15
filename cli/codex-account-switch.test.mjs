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
  const state = { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  const profiles = [{ id: "1", home: "/one" }, { id: "2", home: "/two" }];
  const agents = [{ name: "claw", dir: root, backend: "tmux", panes: [{ cmd: "codex" }] }];
  const ctx = { configPath: "unused", state, agent: {
    paneProcessState: async () => ({ running: !dormant, shell: dormant }), isBusy: async () => busy,
    captureScreen: async () => "› \n GPT-6.1-Sol xhigh · /pane",
    promptTransportState: async () => ({ state: "empty-idle", busy: false }),
    getContext: async () => ({ model: "gpt-6.1-sol", effort: "xhigh" }),
    restartCodex: async (_name, _pane, launch) => { calls.push({ step: "restart", ...launch }); profile = launch.profile.id; },
  }, deliveryQueue: { list: () => [], acquireSessionLease: () => ({ release() {} }),
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
