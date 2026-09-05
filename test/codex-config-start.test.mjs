import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import yaml from "js-yaml";
import { createAgent } from "../agent.mjs";
import { regenerateAgentsYaml } from "../sync.mjs";
import { getContextPercent } from "../core/context.mjs";
import { latestCodexSessionIdentity } from "../core/codex-jsonl-reader.mjs";
import { createState } from "../core/state.mjs";
import { setCodexModelOverride, codexModelOverride } from "../core/codex-profiles.mjs";

vi.mock("../core/context.mjs", async (original) => ({
  ...await original(), getContextPercent: vi.fn(),
}));
vi.mock("../core/codex-jsonl-reader.mjs", async (original) => ({
  ...await original(), latestCodexSessionIdentity: vi.fn(),
}));
vi.mock("../core/codex-session-guard.mjs", async (original) => ({
  ...await original(), liveRolloutWriters: () => [],
}));
vi.mock("../core/codex-readiness.mjs", () => ({ waitForCodexUiReady: async () => true }));

const roots = [];
const SESSION = "11111111-1111-4111-8111-111111111111";
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ model = "gpt-6-astra", effort = null, fresh = false, override = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-config-start-"));
  roots.push(root);
  vi.stubEnv("AMUX_CODEX_PROFILE_1_HOME", join(root, "profile"));
  const configPath = join(root, "agents.yaml");
  mkdirSync(join(root, ".agents", "0"), { recursive: true });
  const state = createState(join(root, "state.json"));
  if (override) setCodexModelOverride(state, "fixture", 0, override.model, override.effort);
  getContextPercent.mockReturnValue(fresh ? null : { model: "gpt-5.6-sol", effort: "max" });
  latestCodexSessionIdentity.mockReturnValue(fresh ? null : { sessionId: SESSION, path: join(root, "old.jsonl") });
  let running = false;
  const calls = [];
  const tmuxExec = async (command) => {
    calls.push(command);
    if (command.includes("#{pane_current_command}")) return { stdout: running ? "node\n" : "bash\n" };
    if (command.includes("send-keys") && command.includes("codex ")) running = true;
    return { stdout: "0\n" };
  };
  const configure = (nextModel = model, nextEffort = effort) => {
    const source = yaml.dump({ guild: "1", agents: { fixture: {
      dir: root, codex: 1,
      ...(nextModel ? { codexModel: nextModel } : {}),
      ...(nextEffort ? { effort: nextEffort } : {}),
    } } });
    writeFileSync(configPath, regenerateAgentsYaml(source, null));
    running = false;
  };
  configure();
  const agent = createAgent({ tmuxSocket: "/unused-config-test.sock", configPath,
    state, tmuxExec, run: async () => ({ stdout: "" }), delay: async () => {} });
  return { agent, state, configure, calls, launch: () => calls.filter((c) => c.includes("send-keys") && c.includes("codex ")).at(-1) };
}

describe("configured Codex model reaches ordinary wake without launching real processes", () => {
  it("resumes the same old session on the configured model and preserves its effort", async () => {
    const f = fixture();
    await f.agent.ensureReady("fixture", 0);
    expect(f.launch()).toContain(SESSION);
    expect(f.launch()).toContain("gpt-6-astra");
    expect(f.launch()).toContain('model_reasoning_effort="max"');
    expect(f.launch()).not.toContain("gpt-5.6-sol");
    expect(f.launch()).not.toContain("--last");
    expect(codexModelOverride(f.state, "fixture", 0)).toBeNull();
  });

  it("does not freeze a config default into a pane override on the next start", async () => {
    const f = fixture();
    await f.agent.ensureReady("fixture", 0);
    f.configure("gpt-5.4", "high");
    await f.agent.ensureReady("fixture", 0);
    expect(f.launch()).toContain("gpt-5.4");
    expect(f.launch()).toContain('model_reasoning_effort="high"');
    expect(codexModelOverride(f.state, "fixture", 0)).toBeNull();
  });

  it("preserves an explicit pane override instead of silently changing its model", async () => {
    const f = fixture({ override: { model: "gpt-5.4", effort: "high" } });
    await f.agent.ensureReady("fixture", 0);
    expect(f.launch()).toContain("gpt-5.4");
    expect(f.launch()).toContain('model_reasoning_effort="high"');
    expect(f.launch()).not.toContain("gpt-6-astra");
  });

  it("keeps legacy continuity when the operator has configured no model", async () => {
    const f = fixture({ model: null });
    await f.agent.ensureReady("fixture", 0);
    expect(f.launch()).toContain("gpt-5.6-sol");
    expect(codexModelOverride(f.state, "fixture", 0)).toEqual({ model: "gpt-5.6-sol", effort: "max" });
  });

  it("uses config on first bootstrap without inventing history or a pane choice", async () => {
    const f = fixture({ fresh: true, effort: "xhigh" });
    await f.agent.ensureReady("fixture", 0);
    expect(f.launch()).toContain("gpt-6-astra");
    expect(f.launch()).toContain('model_reasoning_effort="xhigh"');
    expect(f.launch()).not.toContain("resume");
    expect(codexModelOverride(f.state, "fixture", 0)).toBeNull();
  });

  it("rejects unsafe source model values before any process command", async () => {
    const f = fixture({ model: "bad;command" });
    await expect(f.agent.ensureReady("fixture", 0)).rejects.toThrow(/invalid Codex model/);
    expect(f.launch()).toBeUndefined();
  });
});
