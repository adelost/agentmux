import { feature, unit, expect } from "bdd-vitest";
import {
  classifyPlaywrightProcess,
  detectActivePlaywrightTool,
  findStalePlaywrightProcesses,
  parsePsRows,
  reapStalePlaywrightProcesses,
} from "./playwright-watchdog.mjs";

feature("playwright watchdog process reaper", () => {
  const ps = [
    ' 100  1 100 100 Sl+ 7200 npm exec @playwright/mcp@latest --cdp-endpoint http://localhost:42089',
    ' 101 100 100 100 Sl+ 7199 node /home/me/.npm/_npx/x/node_modules/.bin/playwright-mcp --cdp-endpoint http://localhost:42089',
    ' 102 101 102 102 Ssl 7198 /opt/google/chrome/chrome --user-data-dir=/home/me/.cache/ms-playwright-mcp/mcp-chrome-a --remote-debugging-pipe about:blank',
    ' 103 1 103 103 Sl+ 20 npm exec @playwright/mcp@latest',
    ' 104 1 104 104 Sl+ 7200 node ./node_modules/.bin/playwright test',
    ' 105 104 104 104 Sl+ 7200 /opt/google/chrome/chrome --user-data-dir=/tmp/playwright-test --remote-debugging-pipe',
  ].join("\n");

  unit("classifies only MCP-owned processes", {
    given: ["commands", () => [
      "npm exec @playwright/mcp@latest",
      "node /x/playwright-mcp",
      "/opt/google/chrome/chrome --user-data-dir=/home/me/.cache/ms-playwright-mcp/mcp-chrome-a",
      "node ./node_modules/.bin/playwright test",
    ]],
    when: ["classifying", (commands) => commands.map(classifyPlaywrightProcess)],
    then: ["normal Playwright tests are not matched", (kinds) => {
      expect(kinds).toEqual(["mcp", "mcp", "mcp-chrome", null]);
    }],
  });

  unit("finds only old MCP processes", {
    given: ["ps rows", () => parsePsRows(ps)],
    when: ["finding stale", (rows) => findStalePlaywrightProcesses(rows, { maxAgeMs: 60 * 60_000, nowPid: 999 })],
    then: ["fresh MCP and normal test browser are kept", (stale) => {
      expect(stale.map((p) => p.pid)).toEqual([100, 101, 102]);
    }],
  });

  unit("dry-run does not kill", {
    given: ["ps rows and fake kill", () => ({ rows: parsePsRows(ps), killed: [] })],
    when: ["dry-run reaping", (ctx) => reapStalePlaywrightProcesses({
      rows: ctx.rows,
      dryRun: true,
      maxAgeMs: 60 * 60_000,
      kill: (pid) => ctx.killed.push(pid),
    })],
    then: ["reports candidates without side effects", (result, ctx) => {
      expect(result.candidates).toBe(3);
      expect(ctx.killed).toEqual([]);
    }],
  });
});

feature("playwright watchdog pane detector", () => {
  unit("detects an active Playwright MCP call near the tail", {
    given: ["pane content", () =>
      '● playwright - Navigate to a URL (MCP)(url: "https://sfkbar.pages.dev/cafe")\n' +
      "✽ Crafting… (8m 3s · ↓ 12.9k tokens)\n"],
    when: ["detecting", (content) => detectActivePlaywrightTool(content, "working")],
    then: ["returns a signature", (signature) => {
      expect(signature).toContain("playwright - Navigate");
    }],
  });

  unit("ignores an old Playwright call when a newer tool ran after it", {
    given: ["pane content", () =>
      '● playwright - Navigate to a URL (MCP)(url: "https://sfkbar.pages.dev/cafe")\n' +
      "● Bash(cd repo && gh run view 123)\n" +
      "✽ Crafting… (12s · ↓ 1k tokens)\n"],
    when: ["detecting", (content) => detectActivePlaywrightTool(content, "working")],
    then: ["does not flag it", (signature) => {
      expect(signature).toBeNull();
    }],
  });

  unit("does not treat Playwright-MCP prose as a tool call", {
    given: ["the exact completed response that triggered skybar:3", () =>
      "Så: det här var ett riktigt infra-läckage runt Claude/Playwright-MCP, inte att\n" +
      "vi ska sluta ta screenshots.\n" +
      "✽ Crafting… (10m 12s · ↓ 12.9k tokens)\n"],
    when: ["detecting while another live footer is visible", (content) =>
      detectActivePlaywrightTool(content, "working")],
    then: ["does not flag response prose", (signature) => {
      expect(signature).toBeNull();
    }],
  });

  unit("does not re-arm a historical tool row in an unknown pane", {
    given: ["a completed tool row followed by the model resume warning", () =>
      '● playwright - Take a screenshot (MCP)(filename: "proof.png")\n' +
      "Screenshot saved.\n" +
      "⚠ This session was recorded with model `gpt-5.5` but is resuming with `gpt-5.6`\n"],
    when: ["detecting without a live progress footer", (content) =>
      detectActivePlaywrightTool(content, "unknown")],
    then: ["does not flag scrollback residue", (signature) => {
      expect(signature).toBeNull();
    }],
  });

  unit("does not flag idle panes", {
    given: ["pane content", () =>
      '● playwright - Navigate to a URL (MCP)(url: "https://sfkbar.pages.dev/cafe")\n' +
      "result text\n────\n❯ \n"],
    when: ["detecting", (content) => detectActivePlaywrightTool(content, "idle")],
    then: ["returns null", (signature) => {
      expect(signature).toBeNull();
    }],
  });
});
