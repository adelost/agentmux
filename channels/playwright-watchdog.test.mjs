import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { createPlaywrightWatchdog } from "./playwright-watchdog.mjs";
import { createCaptureDue } from "../core/pulse/capture-due.mjs";

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

  // Row 116c: an idle pane cost the watchdog a capture every round (10 in 10 min on 10 Nov); a call is written to the journal before it runs.
  component("an idle pane is captured once, then only after new activity, and a call being timed is followed every round", {
    given: ["one quiet pane whose journal is unchanged, then a new journal line with a Playwright call", () => {
      const root = mkdtempSync(join(tmpdir(), "playwright-watchdog-"));
      const agentsYamlPath = join(root, "agents.yaml");
      writeFileSync(agentsYamlPath, ["test:", `  dir: ${root}`, "  panes:", "    - cmd: claude", "  discord:", "    \"ch-test\": 0", ""].join("\n"));
      const state = { stamp: "journal-1", screen: "❯ \n", captures: 0, at: 0 };
      const agent = { capturePane: async () => { state.captures++; return state.screen; }, sendEscape: async () => {} };
      const watchdog = createPlaywrightWatchdog({ agent, agentsYamlPath, log: () => {}, reap: () => ({ candidates: 0 }), discord: null,
        captureDue: ((due) => (a, i, _now, options) => due(a, i, state.at, options))(createCaptureDue({ activityOf: () => state.stamp })),
        config: { enabled: true, toolTimeoutMs: 600_000, mcpMaxAgeMs: 60_000, pollMs: 60_000 } });
      return { root, state, watchdog };
    }],
    when: ["ten quiet rounds a minute apart, a new line with a call, then three more rounds", async ({ state, watchdog }) => {
      const counts = [];
      for (let round = 0; round < 10; round++) { state.at = round * 60_000; await watchdog.tick(); }
      counts.push(state.captures);
      state.stamp = "journal-2"; state.screen = STALLED;
      for (let round = 10; round < 13; round++) { state.at = round * 60_000; await watchdog.tick(); }
      counts.push(state.captures);
      return counts;
    }],
    then: ["one capture in ten quiet minutes, then the call is followed every round", (counts, { root }) => {
      try { expect(counts).toEqual([1, 4]); } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });
});
