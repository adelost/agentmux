import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { createPlaywrightWatchdog } from "./playwright-watchdog.mjs";

const STALLED = '● playwright - Navigate to a URL (MCP)(url: "https://example.test/")\n✽ Crafting… (8m 3s · ↓ 12.9k tokens)\n';

feature("playwright watchdog notice", () => {
  component("a stalled browser call is interrupted and reported once, in English", {
    given: ["a working pane stuck on one Playwright call", () => {
      const root = mkdtempSync(join(tmpdir(), "playwright-watchdog-"));
      const agentsYamlPath = join(root, "agents.yaml");
      writeFileSync(agentsYamlPath, ["test:", `  dir: ${root}`, "  panes:", "    - cmd: claude", "  discord:", "    \"ch-test\": 0", ""].join("\n"));
      const sent = [], escapes = [];
      const agent = { capturePane: async () => STALLED, sendEscape: async (name, pane) => { escapes.push(`${name}:${pane}`); } };
      const watchdog = createPlaywrightWatchdog({ agent, agentsYamlPath, log: () => {}, reap: () => ({ candidates: 0 }),
        discord: { send: async (channelId, text) => { sent.push({ channelId, text }); } },
        config: { enabled: true, toolTimeoutMs: 0, mcpMaxAgeMs: 60_000, pollMs: 60_000 } });
      return { root, sent, escapes, watchdog };
    }],
    when: ["three polls see the same call", async (fx) => { await fx.watchdog.tick(); await fx.watchdog.tick(); await fx.watchdog.tick(); return fx; }],
    then: ["one Escape and one notice in the pane's channel", (fx) => { try {
      expect(fx.escapes).toEqual(["test:0"]);
      expect(fx.sent).toEqual([{ channelId: "ch-test",
        text: expect.stringMatching(/^Playwright watchdog: interrupted an MCP browser call in test:0 after \d+s\. Try the screenshot again\.$/u) }]);
    } finally { rmSync(fx.root, { recursive: true, force: true }); } }],
  });
});
