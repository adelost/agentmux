import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { defaultSearchStatePath, loadLastResults, saveLastResults } from "./search-state.mjs";

feature("search state isolation", () => {
  unit("pane and terminal callers receive distinct state paths", {
    when: ["resolving scopes", () => ({
      pane: defaultSearchStatePath({ env: { HOME: "/home/test", TMUX_PANE: "%17" }, parentPid: 8 }),
      otherPane: defaultSearchStatePath({ env: { HOME: "/home/test", TMUX_PANE: "%18" }, parentPid: 8 }),
      terminal: defaultSearchStatePath({ env: { HOME: "/home/test" }, parentPid: 42 }),
    })],
    then: ["no two callers share the same drill-down file", ({ pane, otherPane, terminal }) => {
      expect(new Set([pane, otherPane, terminal]).size).toBe(3);
      expect(pane).toContain("search-last/tmux-17.json");
      expect(terminal).toContain("search-last/terminal-42.json");
    }],
  });

  component("state round-trips atomically in an injected temp path", {
    given: ["one temp state file", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-search-state-"));
      return { root, path: join(root, "nested", "state.json") };
    }],
    when: ["saving and loading", ({ path }) => {
      saveLastResults("needle", [{ path: "/memory.md", line: 3 }], path);
      return loadLastResults(path);
    }],
    then: ["the scoped result is valid", (value, fixture) => {
      expect(value).toMatchObject({ schemaVersion: 1, query: "needle" });
      expect(value.hits).toHaveLength(1);
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });
});
