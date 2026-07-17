import { feature, component, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir } from "./claude-paths.mjs";
import { createClaudeQuotaLifecycle } from "./claude-quota-lifecycle.mjs";
import { assertClaudeQuotaAvailable } from "./claude-quota-target.mjs";
import { quotaRecoveryContinuation } from "./claude-quota-recovery.mjs";

function fixture({ composer = "❯  ", resumeDialogOnLaunch = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-quota-lifecycle-"));
  const homeDir = join(root, "home");
  const repoDir = join(root, "repo");
  const cwd = join(repoDir, ".agents", "0");
  const configPath = join(root, "agents.yaml");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const limitEventId = "22222222-2222-4222-8222-222222222222";
  mkdirSync(cwd, { recursive: true });
  writeFileSync(configPath, [
    "claw:",
    `  dir: ${repoDir}`,
    "  panes:",
    "    - { name: worker, cmd: claude }",
    "",
  ].join("\n"));
  const projectDir = claudeProjectDir(cwd, homeDir);
  const sessionPath = join(projectDir, `${sessionId}.jsonl`);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(sessionPath, [
    JSON.stringify({
      type: "user",
      uuid: "00000000-0000-4000-8000-000000000000",
      timestamp: "2026-07-16T17:00:00.000Z",
      message: { content: "finish the release" },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: limitEventId,
      timestamp: "2026-07-16T17:01:11.018Z",
      message: {
        stop_reason: "stop_sequence",
        content: [{ type: "text", text: "You've hit your session limit · resets 8:50pm (Europe/Stockholm)" }],
      },
    }),
    "",
  ].join("\n"));

  let currentCommand = "node";
  let screen = composer;
  const commands = [];
  const tmuxExec = async (command) => {
    commands.push(command);
    if (command.includes("display-message") && command.includes("pane_current_command")) {
      return { stdout: `${currentCommand}\n` };
    }
    if (command.includes("respawn-pane")) {
      currentCommand = "bash";
      screen = "$ ";
      return { stdout: "" };
    }
    if (command.includes("send-keys") && command.includes("ANTHROPIC_DISABLE_SURVEY")) {
      currentCommand = "node";
      screen = resumeDialogOnLaunch
        ? [
            "This session is 7h 3m old and 234.3k tokens.",
            "❯ 1. Resume from summary (recommended)",
            "  2. Resume full session as-is",
            "  3. Don't ask me again",
            "Enter to confirm · Esc to cancel",
          ].join("\n")
        : "❯  ";
      return { stdout: "" };
    }
    if (command.includes("send-keys") && command.includes("Enter")
        && screen.includes("Resume from summary")) {
      screen = "❯  ";
      return { stdout: "" };
    }
    if (command.includes("capture-pane")) return { stdout: `${screen}\n` };
    return { stdout: "" };
  };
  const lifecycle = createClaudeQuotaLifecycle({
    configPath,
    tmuxSocket: "/tmp/quota-lifecycle-test.sock",
    tmuxExec,
    homeDir,
    delay: async () => {},
    record: () => {},
  });
  const receipt = lifecycle.activeReceipt("claw", 0);
  return {
    root, homeDir, configPath, sessionPath, sessionId, limitEventId,
    lifecycle, receipt, commands,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

feature("Claude quota process boundary", () => {
  component("one pane resumes only the exact persisted session", {
    given: ["a terminal quota receipt and empty composer", fixture],
    when: ["the lifecycle restarts the pane", ({ lifecycle, receipt }) => lifecycle.restart("claw", 0, receipt)],
    then: ["one killed pane launches exact resume", (result, ctx) => {
      expect(result).toMatchObject({ ok: true, sessionId: ctx.sessionId, limitEventId: ctx.limitEventId });
      expect(ctx.commands.filter((command) => command.includes("respawn-pane -k"))).toHaveLength(1);
      const launch = ctx.commands.find((command) => command.includes("ANTHROPIC_DISABLE_SURVEY"));
      expect(launch).toContain(`--resume '${ctx.sessionId}'`);
      expect(launch).not.toContain("--continue");
      ctx.cleanup();
    }],
  });

  component("a large exact session takes Claude's recommended summary path", {
    given: ["a resume command that opens Claude's current size warning", () => fixture({ resumeDialogOnLaunch: true })],
    when: ["the lifecycle waits for the resumed composer", ({ lifecycle, receipt }) => lifecycle.restart("claw", 0, receipt)],
    then: ["the menu is confirmed and the same session becomes ready", (result, ctx) => {
      expect(result).toMatchObject({ ok: true, sessionId: ctx.sessionId, limitEventId: ctx.limitEventId });
      const launchIndex = ctx.commands.findIndex((command) => command.includes("ANTHROPIC_DISABLE_SURVEY"));
      expect(ctx.commands.slice(launchIndex + 1).some((command) => (
        command.includes("send-keys") && command.includes("Enter")
      ))).toBe(true);
      ctx.cleanup();
    }],
  });

  component("a later human turn invalidates restart authority", {
    given: ["a limited session the human already resumed", () => {
      const ctx = fixture();
      writeFileSync(ctx.sessionPath, `${JSON.stringify({
        type: "user",
        uuid: "33333333-3333-4333-8333-333333333333",
        timestamp: "2026-07-16T17:16:46.827Z",
        message: { content: "continue" },
      })}\n`, { flag: "a" });
      return ctx;
    }],
    when: ["the stale poll reaches the boundary", ({ lifecycle, receipt }) => lifecycle.restart("claw", 0, receipt)],
    then: ["the pane is not killed", (result, ctx) => {
      expect(result).toEqual({ ok: false, reason: "limit-receipt-superseded" });
      expect(ctx.commands.some((command) => command.includes("respawn-pane"))).toBe(false);
      ctx.cleanup();
    }],
  });

  component("an unsent human draft also blocks a destructive restart", {
    given: ["an active receipt with text in the composer", () => fixture({ composer: "❯ manual draft" })],
    when: ["the lifecycle inspects the live pane", ({ lifecycle, receipt }) => lifecycle.restart("claw", 0, receipt)],
    then: ["the draft survives", (result, ctx) => {
      expect(result).toEqual({ ok: false, reason: "pane-has-no-empty-claude-composer" });
      expect(ctx.commands.some((command) => command.includes("respawn-pane"))).toBe(false);
      ctx.cleanup();
    }],
  });
});

feature("Claude quota delivery guard", () => {
  component("ordinary work is blocked while the exact limit is active", {
    given: ["a configured limited target", fixture],
    when: ["checking an ordinary prompt", (ctx) => {
      try {
        assertClaudeQuotaAvailable("claw", 0, {
          configPath: ctx.configPath,
          homeDir: ctx.homeDir,
          prompt: "new work",
        });
        return null;
      } catch (error) { return error; }
    }],
    then: ["the transport receives a typed quota fence", (error, ctx) => {
      expect(error).toMatchObject({ code: "AMUX_DELIVERY_BLOCKED", quotaLimited: true });
      ctx.cleanup();
    }],
  });

  component("recovery prose alone cannot cross the active banner", {
    given: ["a configured limited target", fixture],
    when: ["checking copied recovery text without a durable restart", (ctx) => {
      try {
        assertClaudeQuotaAvailable("claw", 0, {
          configPath: ctx.configPath,
          homeDir: ctx.homeDir,
          prompt: quotaRecoveryContinuation(),
        });
        return null;
      } catch (error) { return error; }
    }],
    then: ["the transport remains fenced", (error, ctx) => {
      expect(error).toMatchObject({ code: "AMUX_DELIVERY_BLOCKED", quotaLimited: true });
      ctx.cleanup();
    }],
  });
});
