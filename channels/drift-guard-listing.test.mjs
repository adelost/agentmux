// Guards pulse-11 (docs/DESIGN-pulse.md): drift-guard reads pane processes from the shared listing,
// asks no per-pane process question, and captures only panes whose engine is running.

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";
import { feature, component, expect } from "bdd-vitest";

vi.mock("../cli/config.mjs", () => ({
  listAgents: () => [{ name: "lsrc", dir: "/tmp/drift-guard-listing", panes: [{ cmd: "claude" }, { cmd: "claude" }] }],
  findChannelForPane: () => null,
}));

const { createDriftGuard } = await import("./drift-guard.mjs");
const { parseReminderConfig } = await import("../core/reminder-state.mjs");

feature("drift-guard pane reads", () => {
  component("reads processes from the shared listing and captures only running engines", {
    given: ["one running Claude pane and one pane back at its shell", () => {
      const dir = mkdtempSync(join(tmpdir(), "drift-guard-"));
      const fleetPanes = { panes: vi.fn(async () => new Map([
        ["lsrc:0", { index: 0, id: "%1", command: "claude", dead: false, path: "/w", pid: 41 }],
        ["lsrc:1", { index: 1, id: "%2", command: "bash", dead: false, path: "/w", pid: 42 }],
      ])) };
      const agent = { capturePane: vi.fn(async () => "❯ "), paneProcessState: vi.fn() };
      const guard = createDriftGuard({ agent, agentsYamlPath: "x.yaml", discord: null, fleetPanes,
        config: { ...parseReminderConfig({}), enabled: true, statePath: join(dir, "reminders.json") }, log: () => {} });
      return { dir, guard, agent, fleetPanes };
    }],
    when: ["one round runs", async ({ guard, agent, fleetPanes }) => {
      await guard.tick();
      return { captured: agent.capturePane.mock.calls.map(([name, pane]) => `${name}:${pane}`),
        perPane: agent.paneProcessState.mock.calls.length, listings: fleetPanes.panes.mock.calls.length };
    }],
    then: ["one listing, no per-pane process question, the shell pane not captured", ({ captured, perPane, listings }) => {
      expect(listings).toBe(1);
      expect(perPane).toBe(0);
      expect(captured).toEqual(["lsrc:0"]);
    }],
    cleanup: ({ dir }) => rmSync(dir, { recursive: true, force: true }),
  });
});
