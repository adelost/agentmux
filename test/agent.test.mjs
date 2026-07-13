import { feature, component, unit, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildCodexLaunchCommand, paneDir } from "../agent.mjs";

feature("Codex pane launch isolation", () => {
  unit("account home plus model/effort are process-local on resume and fresh fallback", {
    when: ["building a profile-2 Max launch", () => buildCodexLaunchCommand({
      profileHome: "/home/test/.config/agent/codex-profiles/2",
      model: "gpt-5.6-sol",
      effort: "max",
    })],
    then: ["both branches carry the same isolated settings", (command) => {
      expect(command.match(/CODEX_HOME=/g)).toHaveLength(2);
      expect(command.match(/gpt-5\.6-sol/g)).toHaveLength(2);
      expect(command.match(/model_reasoning_effort="max"/g)).toHaveLength(2);
      expect(command.match(/--yolo/g)).toHaveLength(2);
      expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(command).toContain("codex resume --last");
      expect(command).toContain("||");
    }],
  });

  unit("unsafe model text is rejected before shell construction", {
    when: ["building with shell syntax", () => {
      try {
        buildCodexLaunchCommand({ profileHome: "/home/test/.codex", model: "$(touch /tmp/no)" });
        return null;
      } catch (err) { return err; }
    }],
    then: ["validation fails", (error) => expect(error?.message).toMatch(/invalid Codex model/)],
  });
});

feature("paneDir, session isolation per pane", () => {
  let root;

  const setup = () => {
    root = mkdtempSync(join(tmpdir(), "agentmux-test-"));
    return root;
  };

  const cleanup = () => rmSync(root, { recursive: true, force: true });

  component("pane 0 returns .agents/0/ subdir", {
    given: ["a root dir", setup],
    when: ["paneDir called with pane 0", (root) => paneDir(root, 0)],
    then: [
      "returns .agents/0 path", (dir, root) => {
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

feature("generated agent policy", () => {
  unit("does not reject direct work solely because it crosses a project lane", {
    when: ["generating fresh agent hints", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-policy-test-"));
      paneDir(root, 0);
      const content = readFileSync(join(root, ".agents", "AGENTS.md"), "utf-8");
      rmSync(root, { recursive: true, force: true });
      return content;
    }],
    then: ["the obsolete cross-project refusal is absent", (content) => {
      expect(content).not.toContain("Inget cross-projekt-arbete eller -review");
      expect(content).not.toContain("utanför min lane, fråga Mattias");
    }],
  });
});
