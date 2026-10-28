// Guards pulse-8 (docs/DESIGN-pulse.md): the bridge parsed agentmux.yaml again for every routed call
// (3.8 % of a 30 s bridge profile on 2026-10-28). An unchanged file must not be read again, while a
// change, a save from this process and a caller's edit of its copy must never leave a stale view.

import { chmodSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { feature, unit, expect } from "bdd-vitest";
import { loadConfig, saveConfig } from "./config.mjs";

function configFile(text) {
  const dir = mkdtempSync(join(tmpdir(), "amux-config-"));
  const path = join(dir, "agents.yaml");
  writeFileSync(path, text);
  return { dir, path };
}

feature("loadConfig: parse agentmux.yaml only when it changes", () => {
  unit("an unchanged config is served without reading the file again", {
    given: ["a config that was loaded once and then made unreadable", () => {
      const file = configFile("claw:\n  dir: /tmp/claw\n");
      const first = loadConfig(file.path);
      chmodSync(file.path, 0o000);
      return { ...file, first };
    }],
    when: ["loading it again", ({ path }) => loadConfig(path)],
    then: ["the same agents come back", (config, { dir, path, first }) => {
      chmodSync(path, 0o600);
      rmSync(dir, { recursive: true, force: true });
      expect(first).toEqual({ claw: { dir: "/tmp/claw" } });
      expect(config).toEqual(first);
    }],
  });

  unit("a changed config is read again", {
    given: ["a loaded config whose file then gets new content and a new time", () => {
      const file = configFile("claw:\n  dir: /tmp/claw\n");
      loadConfig(file.path);
      writeFileSync(file.path, "skyvw:\n  dir: /tmp/skyvw\n");
      utimesSync(file.path, new Date(), new Date(Date.now() + 2000));
      return file;
    }],
    when: ["loading it again", ({ path }) => loadConfig(path)],
    then: ["the new agents come back", (config, { dir }) => {
      rmSync(dir, { recursive: true, force: true });
      expect(config).toEqual({ skyvw: { dir: "/tmp/skyvw" } });
    }],
  });

  unit("a config saved by this process is read back at once", {
    given: ["a loaded config", () => {
      const file = configFile("claw:\n  dir: /tmp/claw\n");
      loadConfig(file.path);
      return file;
    }],
    when: ["saving new agents of the same size and loading in the same moment", ({ path }) => {
      saveConfig(path, { claw: { dir: "/tmp/clax" } });
      return loadConfig(path);
    }],
    then: ["the saved agents come back", (config, { dir }) => {
      rmSync(dir, { recursive: true, force: true });
      expect(config).toEqual({ claw: { dir: "/tmp/clax" } });
    }],
  });

  unit("a caller's edit of its copy does not change the next load", {
    given: ["a loaded config that the caller edits", () => {
      const file = configFile("claw:\n  dir: /tmp/claw\n");
      loadConfig(file.path).claw.dir = "/tmp/edited";
      return file;
    }],
    when: ["loading it again", ({ path }) => loadConfig(path)],
    then: ["the file's agents come back", (config, { dir }) => {
      rmSync(dir, { recursive: true, force: true });
      expect(config).toEqual({ claw: { dir: "/tmp/claw" } });
    }],
  });

  unit("a missing config still loads as no agents", {
    given: ["a path with no file", () => join(mkdtempSync(join(tmpdir(), "amux-config-")), "missing.yaml")],
    when: ["loading it", (path) => loadConfig(path)],
    then: ["it is empty", (config) => expect(config).toEqual({})],
  });
});
