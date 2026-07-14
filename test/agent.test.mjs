import { feature, component, unit, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { buildClaudeLaunchCommand, buildCodexLaunchCommand, createAgent, paneDir, shouldPastePrompt } from "../agent.mjs";

feature("durable draft paste fence", () => {
  unit("a vanished durable draft is never permission to type it again", {
    when: ["checking fresh, visible, and vanished durable states", () => ({
      fresh: shouldPastePrompt({ knownDrafted: false, alreadyComposed: false }),
      visible: shouldPastePrompt({ knownDrafted: true, alreadyComposed: true }),
      vanished: shouldPastePrompt({ knownDrafted: true, alreadyComposed: false }),
    })],
    then: ["only a never-written job may paste", (result) =>
      expect(result).toEqual({ fresh: true, visible: false, vanished: false })],
  });
});

feature("Claude pane model pin", () => {
  unit("fresh and resumed launches use exact Opus 4.8 instead of the moving alias", {
    when: ["building both launch forms", () => ({
      fresh: buildClaudeLaunchCommand(),
      resumed: buildClaudeLaunchCommand({ resume: true }),
    })],
    then: ["both commands pin the full model id", ({ fresh, resumed }) => {
      expect(fresh).toContain("--model 'claude-opus-4-8'");
      expect(resumed).toContain("--model 'claude-opus-4-8'");
      expect(fresh).not.toMatch(/--model ['\"]?opus['\"]?(?:\s|$)/);
      expect(resumed).toContain("--continue");
    }],
  });

  unit("unsafe model text is rejected before shell construction", {
    when: ["building with shell syntax", () => {
      try {
        buildClaudeLaunchCommand({ model: "$(touch /tmp/no)" });
        return null;
      } catch (err) { return err; }
    }],
    then: ["validation fails", (error) => expect(error?.message).toMatch(/invalid Claude model/)],
  });
});

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

feature("transport zoom ownership", () => {
  unit("a pane replaces and then restores another pane's existing zoom", {
    given: ["api is zoomed to pane %5 while transport targets %3", () => {
      const calls = [];
      let zoomed = true;
      let active = "%5";
      const tmuxExec = async (cmd) => {
        calls.push(cmd);
        if (cmd.includes("display-message") && cmd.includes("window_zoomed_flag")) return { stdout: zoomed ? "1\n" : "0\n" };
        if (cmd.includes("display-message") && cmd.includes("pane_id")) return { stdout: "%3\n" };
        if (cmd.includes("list-panes")) return { stdout: `%3 ${active === "%3" ? 1 : 0}\n%5 ${active === "%5" ? 1 : 0}\n` };
        if (cmd.includes("select-pane -t 'api:.3'")) active = "%3";
        if (cmd.includes("select-pane -t '%5'")) active = "%5";
        if (cmd.includes("resize-pane -Z")) zoomed = !zoomed;
        return { stdout: "" };
      };
      const agent = createAgent({
        tmuxExec,
        run: async () => ({ stdout: "" }),
        tmuxSocket: "/tmp/test.sock",
        configPath: "/tmp/nonexistent-agents.yaml",
      });
      return { agent, calls, state: () => ({ active, zoomed }) };
    }],
    when: ["transport zooms api:3 and restores its receipt", async ({ agent, calls, state }) => {
      const receipt = await agent.zoomPaneForPicker("api", 3);
      const during = state();
      await agent.restorePaneZoom("api", 3, receipt);
      return { calls, during, after: state(), receipt };
    }],
    then: ["api:3 was visible during transport and %5 owns the final zoom", ({ during, after, receipt }) => {
      expect(receipt).toMatchObject({ changed: true, wasZoomed: true, previousActivePaneId: "%5", targetPaneId: "%3" });
      expect(during).toEqual({ active: "%3", zoomed: true });
      expect(after).toEqual({ active: "%5", zoomed: true });
    }],
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

  component("a Git repo uses its local exclude without dirtying tracked files", {
    given: ["a repository with a tracked .gitignore", () => {
      const r = setup();
      mkdirSync(join(r, ".git", "info"), { recursive: true });
      writeFileSync(join(r, ".gitignore"), "node_modules/\n");
      writeFileSync(join(r, ".git", "info", "exclude"), "# local only\n");
      return r;
    }],
    when: ["paneDir creates agent runtime state", (root) => paneDir(root, 1)],
    then: ["only .git/info/exclude gains the runtime path", (_, root) => {
      expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("node_modules/\n");
      expect(readFileSync(join(root, ".git", "info", "exclude"), "utf-8"))
        .toContain(".agents/");
      cleanup();
    }],
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

  unit("hard-fences pane 2 brokers to same-session implementation workers", {
    when: ["generating fresh agent hints", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-policy-test-"));
      paneDir(root, 0);
      const content = readFileSync(join(root, ".agents", "AGENTS.md"), "utf-8");
      rmSync(root, { recursive: true, force: true });
      return content;
    }],
    then: ["pane 2 manages workers 3+ while panes 0-1 remain reserved", (content) => {
      expect(content).toContain("<!-- amux-hints-version: 1.23.13 -->");
      expect(content).toContain("Broker panel authority is a hard allowlist");
      expect(content).toContain("pane `:2` is the sole manager/broker");
      expect(content).toContain("panes `:3` and above in the same session");
      expect(content).toContain("Panes `:0` and `:1` are");
      expect(content).toContain("`skydive:2` manages `skydive:3` through `skydive:9`");
      expect(content).toContain("`lsrc:2` manages `lsrc:3` through `lsrc:9`");
      expect(content).toContain("`watch:2` manages");
      expect(content).toMatch(/require Mattias\s+to name that exact pane for that exact current task/u);
      expect(content).toContain("outside the allowlist.");
    }],
  });
});
