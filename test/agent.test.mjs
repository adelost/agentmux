import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { paneDir } from "../agent.mjs";

feature("paneDir — session isolation per pane", () => {
  let root;

  const setup = () => {
    root = mkdtempSync(join(tmpdir(), "agentus-test-"));
    return root;
  };

  const cleanup = () => rmSync(root, { recursive: true, force: true });

  component("pane 0 returns .agents/0/ subdir", {
    given: ["a root dir", setup],
    when: ["paneDir called with pane 0", (root) => paneDir(root, 0)],
    then: [
      "returns .agents/0 path and creates it", (dir, root) => {
        expect(dir).toBe(join(root, ".agents", "0"));
        expect(existsSync(dir)).toBe(true);
        cleanup();
      },
    ],
  });

  component("pane 1 returns .agents/1/ subdir", {
    given: ["a root dir", setup],
    when: ["paneDir called with pane 1", (root) => paneDir(root, 1)],
    then: [
      "returns .agents/1 path and creates it", (dir, root) => {
        expect(dir).toBe(join(root, ".agents", "1"));
        expect(existsSync(dir)).toBe(true);
        cleanup();
      },
    ],
  });

  component("pane 2 returns .agents/2/ subdir", {
    given: ["a root dir", setup],
    when: ["paneDir called with pane 2", (root) => paneDir(root, 2)],
    then: [
      "returns .agents/2 path", (dir, root) => {
        expect(dir).toBe(join(root, ".agents", "2"));
        cleanup();
      },
    ],
  });

  component("adds .agents/ to .gitignore", {
    given: ["a root dir with no .gitignore", setup],
    when: ["paneDir called with pane 1", (root) => paneDir(root, 1)],
    then: [
      ".gitignore contains .agents/", (_, root) => {
        const content = readFileSync(join(root, ".gitignore"), "utf-8");
        expect(content).toContain(".agents/");
        cleanup();
      },
    ],
  });

  component("does not duplicate .agents/ in existing .gitignore", {
    given: ["a root dir with .gitignore already containing .agents", () => {
      const r = setup();
      writeFileSync(join(r, ".gitignore"), "node_modules/\n.agents/\n");
      return r;
    }],
    when: ["paneDir called with pane 1", (root) => paneDir(root, 1)],
    then: [
      ".gitignore has only one .agents/ entry", (_, root) => {
        const content = readFileSync(join(root, ".gitignore"), "utf-8");
        const count = (content.match(/\.agents/g) || []).length;
        expect(count).toBe(1);
        cleanup();
      },
    ],
  });

  component("appends to existing .gitignore without overwriting", {
    given: ["a root dir with existing .gitignore content", () => {
      const r = setup();
      writeFileSync(join(r, ".gitignore"), "node_modules/\n*.log\n");
      return r;
    }],
    when: ["paneDir called with pane 1", (root) => paneDir(root, 1)],
    then: [
      ".gitignore preserves existing content", (_, root) => {
        const content = readFileSync(join(root, ".gitignore"), "utf-8");
        expect(content).toContain("node_modules/");
        expect(content).toContain("*.log");
        expect(content).toContain(".agents/");
        cleanup();
      },
    ],
  });
});
