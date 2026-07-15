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
  unit("Claude delegates every autonomous tool call to auto mode without Chrome integration", {
    when: ["reading the canonical argv", () => ({
      args: CLAUDE_AUTONOMOUS_ARGS,
      flags: CLAUDE_AUTONOMOUS_FLAGS,
    })],
    then: ["the native reviewer is enabled and the bypass is absent", ({ args, flags }) => {
      expect(args).toEqual(["--permission-mode", "auto", "--no-chrome"]);
      expect(flags).toBe("--permission-mode auto --no-chrome");
      expect(flags).not.toContain("dangerously");
    }],
  });

  unit("Codex keeps workspace writes and network while escalation is fail-closed reviewed", {
    when: ["reading CLI and app-server policy", () => ({
      args: CODEX_AUTONOMOUS_ARGS,
      flags: CODEX_AUTONOMOUS_FLAGS,
      appServer: CODEX_APP_SERVER_ARGS,
      thread: CODEX_AUTONOMOUS_THREAD_POLICY,
      turn: CODEX_AUTONOMOUS_TURN_POLICY,
    })],
    then: ["all native seams carry the same bounded authority", (policy) => {
      expect(policy.flags).toContain("--sandbox workspace-write");
      expect(policy.flags).toContain("--ask-for-approval on-request");
      expect(policy.flags).toContain("sandbox_workspace_write.network_access=true");
      expect(policy.flags).toContain('approvals_reviewer="auto_review"');
      expect(policy.flags).not.toContain("--yolo");
      expect(policy.appServer).toContain('approvals_reviewer="auto_review"');
      expect(policy.thread).toEqual({
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      });
      expect(policy.turn).toEqual({
        sandboxPolicy: { type: "workspaceWrite", networkAccess: true },
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      });
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

  unit("no production launcher can silently restore a vendor bypass", {
    when: ["scanning every Claude and Codex launch surface", () => LAUNCH_SURFACES.map((path) => ({
      path,
      source: readFileSync(join(ROOT, path), "utf8"),
    }))],
    then: ["all bypass spellings and full-access policies are absent", (surfaces) => {
      for (const { path, source } of surfaces) {
        expect(source, path).not.toContain("--dangerously-skip-permissions");
        expect(source, path).not.toContain("--yolo");
        expect(source, path).not.toContain('sandbox: "danger-full-access"');
        expect(source, path).not.toContain('approvalPolicy: "never"');
      }
    }],
  });
});

feature("external navigation defense in depth", () => {
  unit("direct browser GUI entry points are forbidden while headless tests stay autonomous", {
    when: ["reading the installed execpolicy fixture", () => CODEX_EXTERNAL_NAVIGATION_RULES],
    then: ["direct navigation is blocked and ordinary Playwright tests are excluded", (rules) => {
      expect(rules).toContain('decision = "forbidden"');
      expect(rules).toContain('"xdg-open"');
      expect(rules).toContain('"google-chrome"');
      expect(rules).toContain('"playwright", ["open", "codegen", "show-report"]');
      expect(rules).toContain('"playwright", "test", ["--ui", "--headed"]');
      expect(rules).toContain('not_match = ["npx playwright test"]');
      expect(rules).not.toContain('decision = "allow"');
      expect(rules).not.toContain('decision = "prompt"');
    }],
  });

  component("Codex's native evaluator blocks GUI launch and leaves headless tests unmatched", {
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
    then: ["the vendor evaluator returns forbidden, forbidden, and no rule", (result, ctx) => {
      expect(result.gui.decision).toBe("forbidden");
      expect(result.interactive.decision).toBe("forbidden");
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
