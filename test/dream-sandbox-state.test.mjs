import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect } from "vitest";
import { createState } from "../core/state.mjs";
import { enterDreamSandbox, dreamSandboxFor, markDreamSandboxRunning, finishDreamSandbox, DREAM_SANDBOX_STATE } from "../core/dream-sandbox.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dream-startup-fence-")), output = join(root, "artifacts"); mkdirSync(output);
  const statePath = join(root, "state.json"), state = createState(statePath), sessionId = "11111111-1111-4111-8111-111111111111";
  const owner = { agent: "fixture", pane: 1, engine: "codex" }, compact = { sessionId }, quality = { model: "gpt-6.1-sol", effort: "xhigh" };
  const input = { runId: "run", sha256: "a".repeat(64), sandbox: { root: output, profile: "amux_dream_fixture" } };
  const fx = { root, statePath, state, owner, compact, quality, input, calls: 0, pending: [] };
  fx.ctx = { state, deliveryQueue: { acquireSessionLease: () => ({ release() {} }), list: () => fx.pending }, agent: {
    isBusy: async () => false, captureScreen: async () => "› Ask Codex to do anything\nGPT-6.1-Sol xhigh · /fixture",
    restartCodex: async (_name, _pane, options) => {
      fx.calls++; expect(options.resumeSessionId).toBe(sessionId);
      markDreamSandboxRunning(state, owner.agent, owner.pane, state.get(DREAM_SANDBOX_STATE)["fixture:1"]);
    },
  } };
  fx.enter = () => enterDreamSandbox(fx.ctx, owner, input, compact, quality);
  return fx;
}

it("keeps the exact session/profile restriction after reload and releases only native terminal runs", async () => {
  const fx = fixture();
  try {
    const proof = await fx.enter(), reloaded = createState(fx.statePath);
    expect(dreamSandboxFor(reloaded, "fixture", 1, fx.compact.sessionId, proof.profileId).root).toBe(fx.input.sandbox.root);
    expect(() => dreamSandboxFor(reloaded, "fixture", 1, "other", proof.profileId)).toThrow("session-mismatch");
    expect(() => dreamSandboxFor(reloaded, "fixture", 1, fx.compact.sessionId, "other")).toThrow("session-mismatch");
    await expect(fx.enter()).rejects.toThrow("prior-outcome-unknown");
    expect(fx.calls).toBe(1);
    finishDreamSandbox(fx.ctx, fx.owner, fx.input);
    expect(dreamSandboxFor(reloaded, "fixture", 1, "new-session", "new-profile")).toBeNull();
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

it("does not retry or erase an uncertain startup after a failed restart", async () => {
  const fx = fixture();
  try {
    fx.ctx.agent.restartCodex = async () => { fx.calls++; throw Error("lost startup result"); };
    await expect(fx.enter()).rejects.toThrow("lost startup result");
    await expect(fx.enter()).rejects.toThrow("prior-outcome-unknown");
    expect(fx.calls).toBe(1);
    expect(createState(fx.statePath).get(DREAM_SANDBOX_STATE)["fixture:1"].status).toBe("armed");
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

for (const status of ["pending", "submitted", "submitting", "delivered-unverified"]) it(`does not restart over ${status} delivery`, async () => {
  const fx = fixture();
  try {
    fx.pending = [{ status }];
    await expect(fx.enter()).rejects.toThrow("active-writer-or-draft");
    expect(fx.calls).toBe(0);
    expect(fx.state.get(DREAM_SANDBOX_STATE)).toBeUndefined();
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});

it("preserves a foreign composer without clearing or restarting it", async () => {
  const fx = fixture();
  try {
    fx.ctx.agent.captureScreen = async () => "› Human draft\nGPT-6.1-Sol xhigh · /fixture";
    await expect(fx.enter()).rejects.toThrow("active-writer-or-draft");
    expect(fx.calls).toBe(0);
  } finally { rmSync(fx.root, { recursive: true, force: true }); }
});
