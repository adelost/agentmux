import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { claudeProjectDir } from "./claude-paths.mjs";
import { createTuiStallRecovery } from "./tui-stall-recovery.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentmux-tui-recovery-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const paneDir = join(workspace, ".agents", "6");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const projectDir = claudeProjectDir(paneDir, home);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({ type: "user" })}\n`);
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const stateData = {
    watcher_last_model: { "claw:6": { model: "claude-fable-5[1m]", effort: null } },
  };
  const commands = [];
  const keys = [];
  const screens = [
    [
      "❯ 1. Resume from summary (recommended)",
      "  2. Resume full session as-is",
      "  3. Don't ask me again",
      "Enter to confirm · Esc to cancel",
    ].join("\n"),
    "❯ \n",
  ];
  const tmux = {
    runShell: async (_target, command) => { commands.push(command); },
    captureScreen: async () => screens.shift() || "❯ \n",
    sendKeys: async (_target, value) => { keys.push(value); },
  };
  let runningChecks = 0;
  const recovery = createTuiStallRecovery({
    tmux,
    state: {
      get: (key, fallback) => key in stateData ? stateData[key] : fallback,
      set: (key, value) => { stateData[key] = value; return value; },
    },
    delay: async () => {},
    configFor: () => ({ dir: workspace, panes: Array.from({ length: 7 }, (_, pane) => ({
      cmd: pane === 6 ? "claude" : "bash",
    })) }),
    paneDirectory: (_root, pane) => join(workspace, ".agents", String(pane)),
    isPaneDead: async () => false,
    respawnPane: async () => {},
    isAlreadyRunning: async () => runningChecks++ > 0,
    resolveSessionFlag: async () => "--continue",
    isBusy: async () => true,
    promptTransportState: async () => ({ state: "hidden", busy: false }),
    restartCodex: async () => {},
  });
  return { root, oldHome, workspace, sessionId, recovery, commands, keys };
}

feature("exact TUI crash recovery", () => {
  component("Claude keeps pane Fable, exact session, and accepts summary resume", {
    given: ["an interrupted Fable pane with persisted session identity", () => fixture()],
    when: ["starting and proving the live summary dialog", async (ctx) => {
      await ctx.recovery.startClaude("claw", "claw:.6", ctx.workspace, 6);
      const ready = await ctx.recovery.waitForClaudeReady("claw:.6", "claw", 6);
      const targets = await ctx.recovery.interruptedFleetTargets([{
        name: "claw",
        cfg: { dir: ctx.workspace, panes: Array.from({ length: 7 }, (_, pane) => ({
          cmd: pane === 6 ? "claude" : "bash",
        })) },
      }], () => {});
      return { ready, targets };
    }],
    then: ["the launch and continuation stay bound to the same pane", ({ ready, targets }, ctx) => {
      expect(ctx.commands).toHaveLength(1);
      expect(ctx.commands[0]).toContain("--model 'claude-fable-5'");
      expect(ctx.commands[0]).toContain(`--resume '${ctx.sessionId}'`);
      expect(ctx.commands[0]).not.toContain("claude-opus-4-8");
      expect(ctx.keys).toEqual(["Enter"]);
      expect(ready).toBe(true);
      expect(targets).toEqual([{
        agentName: "claw", pane: 6, dialect: "claude", sessionId: ctx.sessionId,
      }]);
      if (ctx.oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = ctx.oldHome;
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("only the caller-proven exact draft may cross a pane restart", {
    given: ["an idle Codex pane whose composer still contains the submitted job", () => {
      const restarts = [];
      const observedDrafts = [];
      const recovery = createTuiStallRecovery({
        tmux: {}, state: { get: (_key, fallback) => fallback, set: () => {} }, delay: async () => {},
        configFor: () => ({ dir: "/workspace", panes: [{ cmd: "codex" }] }),
        paneDirectory: (root) => root,
        isPaneDead: async () => false,
        respawnPane: async () => {},
        isAlreadyRunning: async () => true,
        resolveSessionFlag: async () => "",
        isBusy: async () => false,
        promptTransportState: async (_name, _pane, expected) => {
          observedDrafts.push(expected);
          return { state: "drafted", busy: false };
        },
        restartCodex: async (...args) => { restarts.push(args); },
      });
      return { recovery, restarts, observedDrafts };
    }],
    when: ["the generic path and then the exact-job path request restart", async (ctx) => {
      ctx.generic = await ctx.recovery.restartPaneExact("claw", 0);
      ctx.exact = await ctx.recovery.restartPaneExact("claw", 0, { expectedDraft: "owned prompt" });
    }],
    then: ["the foreign-looking draft blocks generic recovery but the exact draft resumes", (_, ctx) => {
      expect(ctx.generic).toEqual({ ok: false, reason: "composer-drafted" });
      expect(ctx.exact).toMatchObject({ ok: true, dialect: "codex" });
      expect(ctx.observedDrafts).toEqual(["", "owned prompt"]);
      expect(ctx.restarts).toHaveLength(1);
    }],
  });
});
