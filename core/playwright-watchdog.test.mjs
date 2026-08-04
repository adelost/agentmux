import { feature, unit, expect } from "bdd-vitest";
import {
  classifyPlaywrightProcess,
  detectActivePlaywrightTool,
  findStalePlaywrightProcesses,
  parseCdpClientCount,
  parsePsRows,
  reapStalePlaywrightProcesses,
} from "./playwright-watchdog.mjs";

const IDLE_SHARED_BROWSER = {
  known: true, clients: 0, heartbeatAgeMs: null, heartbeatFresh: false, error: null,
};

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
      observe: () => IDLE_SHARED_BROWSER,
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

feature("shared agent-browser survives the age reaper (SRC-0136)", () => {
  // The incident shape: skydive:5 held a connectOverCDP wait against the shared
  // headed Chrome when the 60m age rule fired and killed the measurement.
  const sharedBrowser = " 200 1 200 200 Ssl 7200 /opt/google/chrome/chrome"
    + " --user-data-dir=/home/me/.cache/agent-browser/chrome-42089 --remote-debugging-port=42089";
  const mcpClient = " 201 1 201 201 Sl+ 7200 npm exec @playwright/mcp@latest"
    + " --cdp-endpoint http://localhost:42089";
  const ephemeralMcp = " 202 1 202 202 Sl+ 7200 npm exec @playwright/mcp@latest";
  const rows = parsePsRows([sharedBrowser, mcpClient, ephemeralMcp].join("\n"));

  const reapWith = (activity, extra = {}) => {
    const killed = [];
    const result = reapStalePlaywrightProcesses({
      rows, maxAgeMs: 60 * 60_000, kill: (pid) => killed.push(pid),
      observe: () => activity, ...extra,
    });
    return { killed, result };
  };

  unit("an aged shared browser with an attached CDP client is preserved", {
    given: ["a live client on :42089", () => ({ ...IDLE_SHARED_BROWSER, clients: 1 })],
    when: ["reaping", (activity) => reapWith(activity)],
    then: ["only the ephemeral MCP dies, the shared session lives", ({ killed, result }) => {
      expect(killed).toEqual([202]);
      expect(result.skipped.map((s) => s.pid).sort()).toEqual([200, 201]);
      expect(result.skipped[0].reason).toContain("1 attached CDP client");
    }],
  });

  unit("an aged shared browser with a fresh heartbeat is preserved", {
    given: ["no client but a 30s-old ownership claim", () =>
      ({ ...IDLE_SHARED_BROWSER, heartbeatAgeMs: 30_000, heartbeatFresh: true })],
    when: ["reaping", (activity) => reapWith(activity)],
    then: ["the claim protects it", ({ killed, result }) => {
      expect(killed).toEqual([202]);
      expect(result.skipped.map((s) => s.reason).join()).toContain("heartbeat is 30s old");
    }],
  });

  unit("an aged, idle, unclaimed shared browser is still reaped", {
    given: ["no client and no claim", () => IDLE_SHARED_BROWSER],
    when: ["reaping", (activity) => reapWith(activity)],
    then: ["the leak protection survives the fix", ({ killed, result }) => {
      expect(killed.sort()).toEqual([200, 201, 202]);
      expect(result.skipped).toEqual([]);
    }],
  });

  unit("unreadable activity warns and skips instead of killing blind", {
    given: ["a probe that could not run", () =>
      ({ known: false, clients: null, heartbeatAgeMs: null, heartbeatFresh: false, error: "ss: not found" })],
    when: ["reaping", (activity) => reapWith(activity)],
    then: ["the shared session is spared and the reason is stated", ({ killed, result }) => {
      expect(killed).toEqual([202]);
      expect(result.skipped.map((s) => s.reason).join()).toContain("unreadable (ss: not found)");
    }],
  });

  unit("a client attaching between scan and kill cancels the kill", {
    given: ["idle at scan, busy at the pre-kill recheck", () => {
      let calls = 0;
      return () => (++calls === 1 ? IDLE_SHARED_BROWSER : { ...IDLE_SHARED_BROWSER, clients: 1 });
    }],
    when: ["reaping", (observe) => {
      const killed = [];
      const result = reapStalePlaywrightProcesses({
        rows, maxAgeMs: 60 * 60_000, kill: (pid) => killed.push(pid), observe,
      });
      return { killed, result };
    }],
    then: ["the race loses to the live client", ({ killed, result }) => {
      expect(killed).toEqual([202]);
      expect(result.skipped.map((s) => s.reason).join()).toContain("arrived after scan");
    }],
  });

  unit("a reused pid is never killed", {
    given: ["the scanned pid now holds a much younger process", () => rows],
    when: ["reaping against a rescan where pid 202 restarted", (scanRows) => {
      const killed = [];
      reapStalePlaywrightProcesses({
        rows: scanRows, maxAgeMs: 60 * 60_000, kill: (pid) => killed.push(pid),
        observe: () => IDLE_SHARED_BROWSER,
        rescan: () => scanRows.map((r) => (r.pid === 202 ? { ...r, etimes: 3 } : r)),
      });
      return killed;
    }],
    then: ["the stranger wearing that pid survives", (killed) => {
      expect(killed).not.toContain(202);
    }],
  });

  unit("counts the browser side of a loopback connection, not both ends", {
    given: ["ss output where one client shows twice", () =>
      "Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n"
      + "0      0          127.0.0.1:42089       127.0.0.1:34558\n"
      + "0      0          127.0.0.1:34558       127.0.0.1:42089\n"],
    when: ["counting", (stdout) => parseCdpClientCount(stdout, 42089)],
    then: ["one client is one client", (count) => {
      expect(count).toBe(1);
    }],
  });
});
