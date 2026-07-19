import { feature, component, unit, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  CLAUDE_AUTONOMOUS_ARGS,
  CLAUDE_AUTONOMOUS_FLAGS,
  CODEX_APP_SERVER_ARGS,
  CODEX_AUTONOMOUS_ARGS,
  CODEX_AUTONOMOUS_FLAGS,
  CODEX_AUTONOMOUS_THREAD_POLICY,
  CODEX_AUTONOMOUS_TURN_POLICY,
  CODEX_EXTERNAL_NAVIGATION_RULES,
  KIMI_AUTONOMOUS_ARGS,
  KIMI_AUTONOMOUS_FLAGS,
  renderShellArgs,
} from "../core/execution-safety.mjs";
import { ensureCodexExecutionSafety } from "../core/codex-profiles.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const LAUNCH_SURFACES = [
  "agent.mjs",
  "sync.mjs",
  "cli/config.mjs",
  "cli/run.mjs",
  "cli/plan.mjs",
  "spikes/web-ui/runtime-control.mjs",
  "spikes/web-ui/server.mjs",
];

feature("shared autonomous execution contract", () => {
  unit("Claude uses the centrally authorized permission bypass", {
    when: ["reading the canonical argv", () => ({
      args: CLAUDE_AUTONOMOUS_ARGS,
      flags: CLAUDE_AUTONOMOUS_FLAGS,
    })],
    then: ["the exact dangerous-skip flag is present once", ({ args, flags }) => {
      expect(args).toEqual(["--dangerously-skip-permissions"]);
      expect(flags).toBe("--dangerously-skip-permissions");
    }],
  });

  unit("Codex uses yolo semantics in CLI and native app-server turns", {
    when: ["reading CLI and app-server policy", () => ({
      args: CODEX_AUTONOMOUS_ARGS,
      flags: CODEX_AUTONOMOUS_FLAGS,
      appServer: CODEX_APP_SERVER_ARGS,
      thread: CODEX_AUTONOMOUS_THREAD_POLICY,
      turn: CODEX_AUTONOMOUS_TURN_POLICY,
    })],
    then: ["all native seams carry full access without approval prompts", (policy) => {
      expect(policy.args).toEqual(["--yolo"]);
      expect(policy.flags).toBe("--yolo");
      expect(policy.appServer).toEqual(["app-server", "--stdio"]);
      expect(policy.thread).toEqual({
        sandbox: "danger-full-access",
        approvalPolicy: "never",
      });
      expect(policy.turn).toEqual({
        sandboxPolicy: { type: "dangerFullAccess" },
        approvalPolicy: "never",
      });
    }],
  });

  unit("Kimi uses the centrally managed autonomous policy", {
    when: ["reading the canonical argv", () => ({
      args: KIMI_AUTONOMOUS_ARGS,
      flags: KIMI_AUTONOMOUS_FLAGS,
    })],
    then: ["the exact yolo flag is present once", ({ args, flags }) => {
      expect(args).toEqual(["--yolo"]);
      expect(flags).toBe("--yolo");
    }],
  });

  unit("fixed shell arguments preserve literal boundaries", {
    when: ["rendering an argument containing shell syntax", () => renderShellArgs([
      "-c", 'approvals_reviewer="auto_review"', "a'b",
    ])],
    then: ["config text and quotes remain data", (flags) => {
      expect(flags).toBe(`-c 'approvals_reviewer="auto_review"' 'a'\\''b'`);
    }],
  });

  unit("no production launcher can drift from the shared autonomous policy", {
    when: ["scanning every Claude and Codex launch surface", () => LAUNCH_SURFACES.map((path) => ({
      path,
      source: readFileSync(join(ROOT, path), "utf8"),
    }))],
    then: ["all bypass spellings and full-access policies stay centralized", (surfaces) => {
      for (const { path, source } of surfaces) {
        expect(source, path).not.toContain("--dangerously-skip-permissions");
        expect(source, path).not.toContain("--yolo");
        expect(source, path).not.toContain('sandbox: "danger-full-access"');
        expect(source, path).not.toContain('approvalPolicy: "never"');
      }
    }],
  });
});

feature("autonomous Codex profile reconciliation", () => {
  unit("the agentmux-owned execpolicy contains no stale restrictions", {
    when: ["reading the installed execpolicy fixture", () => CODEX_EXTERNAL_NAVIGATION_RULES],
    then: ["the managed file is comment-only", (rules) => {
      expect(rules).toContain("Full autonomous mode");
      expect(rules).not.toContain("prefix_rule");
    }],
  });

  component("Codex's native evaluator leaves every command class unmatched", {
    given: ["the managed rules installed in an isolated profile", () => {
      const home = mkdtempSync(join(tmpdir(), "amux-native-execpolicy-"));
      return { home, rulesPath: ensureCodexExecutionSafety({ home }) };
    }],
    when: ["evaluating direct GUI, interactive Playwright, and headless Playwright commands", ({ rulesPath }) => {
      const check = (...command) => {
        const result = spawnSync("codex", [
          "execpolicy", "check", "--rules", rulesPath, "--", ...command,
        ], { encoding: "utf8" });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(result.stderr || result.stdout);
        return JSON.parse(result.stdout);
      };
      return {
        gui: check("xdg-open", "https://example.com"),
        interactive: check("npx", "playwright", "codegen", "https://example.com"),
        headless: check("npx", "playwright", "test"),
      };
    }],
    then: ["the managed policy does not constrain GUI or headless execution", (result, ctx) => {
      expect(result.gui.matchedRules).toEqual([]);
      expect(result.gui.decision).toBeUndefined();
      expect(result.interactive.matchedRules).toEqual([]);
      expect(result.interactive.decision).toBeUndefined();
      expect(result.headless.matchedRules).toEqual([]);
      expect(result.headless.decision).toBeUndefined();
      rmSync(ctx.home, { recursive: true, force: true });
    }],
  });

  unit("each Codex profile receives the canonical managed rule without touching other rules", {
    given: ["a profile with an unrelated user rule", () => {
      const home = mkdtempSync(join(tmpdir(), "amux-execution-safety-"));
      const userRule = join(home, "rules", "user.rules");
      return { home, userRule };
    }],
    when: ["installing and then repairing a drifted managed rule", ({ home, userRule }) => {
      const installed = ensureCodexExecutionSafety({ home });
      writeFileSync(userRule, "# user-owned\n");
      writeFileSync(installed, "# stale\n");
      ensureCodexExecutionSafety({ home });
      return {
        home,
        installed: readFileSync(installed, "utf8"),
        user: readFileSync(userRule, "utf8"),
      };
    }],
    then: ["only agentmux's named rule is reconciled", ({ home, installed, user }) => {
      expect(installed).toBe(CODEX_EXTERNAL_NAVIGATION_RULES);
      expect(user).toBe("# user-owned\n");
      rmSync(home, { recursive: true, force: true });
    }],
  });
});
