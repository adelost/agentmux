import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { keepClaudeDefaultModel } from "./claude-default-model.mjs";

const SETTINGS = `${JSON.stringify({ model: "opus[1m]", theme: "dark" }, null, 2)}\n`;

// What Claude Code 2.1.303 does on an interactive /model: the pick becomes the saved default.
const claudeSavesPick = (path, model) => {
  const settings = JSON.parse(readFileSync(path, "utf-8"));
  writeFileSync(path, `${JSON.stringify({ ...settings, model }, null, 2)}\n`);
};

feature("a pane's model switch keeps the default for new sessions", () => {
  component("two switches at once leave the default as it was", {
    given: ["the shared settings with opus[1m] and two panes switching to Sonnet together", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-claude-default-"));
      const path = join(root, "settings.json");
      writeFileSync(path, SETTINGS);
      const options = { files: [path], lockPath: join(root, "default.lock"), lateWriteMs: 0,
        wait: () => new Promise((resolve) => setImmediate(resolve)) };
      return { root, path, options };
    }],
    when: ["the second switch starts while the first one's pick is saved and ends after it", async ({ path, options }) => {
      const gate = () => { let open; const shut = new Promise((resolve) => { open = resolve; }); return { shut, open }; };
      const tick = () => new Promise((resolve) => setImmediate(resolve));
      const firstGate = gate(), secondGate = gate();
      const switching = (name, { shut }) => async () => {
        claudeSavesPick(path, "claude-sonnet-5-5");
        await shut;
        return name;
      };
      const first = keepClaudeDefaultModel(switching("first", firstGate), options);
      await tick();
      const second = keepClaudeDefaultModel(switching("second", secondGate), options);
      await tick();
      firstGate.open();
      const firstDone = await first;
      secondGate.open();
      return [firstDone, await second];
    }],
    then: ["both switches finish and the file is byte for byte the one before", (results, { root, path }) => {
      try {
        expect(results.map((kept) => kept.result)).toEqual(["first", "second"]);
        expect(readFileSync(path, "utf-8")).toBe(SETTINGS);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });
});
