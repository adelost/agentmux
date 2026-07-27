import { feature, component, unit, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildClaudeLaunchCommand, buildCodexLaunchCommand, createAgent, paneDir,
  shouldPastePrompt, submitWithDurableFence,
} from "../agent.mjs";
import { claudeProjectDir } from "../core/claude-paths.mjs";

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

  component("the ambiguous submit fence is durable before physical Enter", {
    given: ["three observable submit steps", () => {
      const calls = [];
      return {
        calls,
        submit: () => submitWithDurableFence({
          onSubmitting: async () => { calls.push("fence"); },
          sendEnter: async () => { calls.push("enter"); },
          onSubmitted: async () => {
            calls.push("submitted");
            throw new Error("process crashed after Enter");
          },
        }).catch((error) => error),
      };
    }],
    when: ["the process fails after the physical key but before final state", ({ submit }) => submit()],
    then: ["the durable fence necessarily precedes Enter and the missing final callback remains detectable", (error, ctx) => {
      expect(error.message).toBe("process crashed after Enter");
      expect(ctx.calls).toEqual(["fence", "enter", "submitted"]);
    }],
  });

  component("a failed durable fence prevents physical Enter", {
    given: ["a persistence failure before submit", () => {
      const calls = [];
      return {
        calls,
        submit: () => submitWithDurableFence({
          onSubmitting: async () => {
            calls.push("fence");
            throw new Error("disk unavailable");
          },
          sendEnter: async () => { calls.push("enter"); },
          onSubmitted: async () => { calls.push("submitted"); },
        }).catch((error) => error),
      };
    }],
    when: ["the durable transition cannot be written", ({ submit }) => submit()],
    then: ["no physical or final submit step runs", (error, ctx) => {
      expect(error.message).toBe("disk unavailable");
      expect(ctx.calls).toEqual(["fence"]);
    }],
  });
});

feature("Claude pane model pin", () => {
  unit("fresh and resumed launches use exact Opus 5 instead of the moving alias", {
    when: ["building both launch forms", () => ({
      fresh: buildClaudeLaunchCommand(),
      resumed: buildClaudeLaunchCommand({ resume: true }),
    })],
    then: ["both commands pin the full model id", ({ fresh, resumed }) => {
      expect(fresh).toContain("--model 'claude-opus-5'");
      expect(resumed).toContain("--model 'claude-opus-5'");
      expect(fresh).toContain("--dangerously-skip-permissions");
      expect(resumed).toContain("--dangerously-skip-permissions");
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

  unit("a persisted Fable statusline id resumes as the same launch model", {
    when: ["building after a Fable pane crash", () => buildClaudeLaunchCommand({
      model: "claude-fable-5[1m]",
      resumeSessionId: "11111111-1111-4111-8111-111111111111",
    })],
    then: ["display metadata is stripped while Fable and the exact session stay pinned", (command) => {
      expect(command).toContain("--model 'claude-fable-5'");
      expect(command).toContain("--resume '11111111-1111-4111-8111-111111111111'");
      expect(command).not.toContain("claude-opus-5");
      expect(command).not.toContain("[1m]");
    }],
  });

  unit("a rollback launch resumes the exact native Claude session", {
    when: ["building an exact rollback command", () => buildClaudeLaunchCommand({
      resume: true,
      resumeSessionId: "11111111-1111-4111-8111-111111111111",
    })],
    then: ["the exact id replaces cwd-relative continue", (command) => {
      expect(command).toContain("--resume '11111111-1111-4111-8111-111111111111'");
      expect(command).not.toContain("--continue");
    }],
  });
});

feature("Claude quota delivery boundary", () => {
  component("an active persisted limit blocks the physical pane write", {
    given: ["a running Claude pane with a terminal limit receipt", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-agent-quota-"));
      const homeDir = join(root, "home");
      const repoDir = join(root, "repo");
      const cwd = join(repoDir, ".agents", "0");
      const configPath = join(root, "agents.yaml");
      const sessionId = "33333333-3333-4333-8333-333333333333";
      mkdirSync(cwd, { recursive: true });
      writeFileSync(configPath, [
        "claw:",
        `  dir: ${repoDir}`,
        "  panes:",
        "    - { name: worker, cmd: claude }",
        "",
      ].join("\n"));
      const projectDir = claudeProjectDir(cwd, homeDir);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify({
        type: "assistant",
        uuid: "44444444-4444-4444-8444-444444444444",
        timestamp: "2026-07-16T17:01:11.018Z",
        message: {
          content: [{ type: "text", text: "You've hit your session limit · resets 8:50pm (Europe/Stockholm)" }],
        },
      })}\n`);
      const oldHome = process.env.HOME;
      process.env.HOME = homeDir;
      const calls = [];
      const tmuxExec = async (command) => {
        calls.push(command);
        if (command.includes("show-environment")) return { stdout: "" };
        if (command.includes("list-panes")) return { stdout: "0\n" };
        if (command.includes("#{pane_current_command}")) return { stdout: "node\n" };
        if (command.includes("#{pane_dead}")) return { stdout: "0\n" };
        return { stdout: "" };
      };
      return {
        root,
        oldHome,
        calls,
        agent: createAgent({
          tmuxSocket: "/tmp/agent-quota-test.sock",
          configPath,
          tmuxExec,
          run: async () => ({ stdout: "" }),
          delay: async () => {},
        }),
      };
    }],
    when: ["an ordinary message reaches sendOnly", ({ agent }) =>
      agent.sendOnly("claw", "do not lose this message", 0).catch((error) => error)],
    then: ["the typed quota fence fires before paste or Enter", (error, ctx) => {
      expect(error).toMatchObject({ code: "AMUX_DELIVERY_BLOCKED", quotaLimited: true });
      expect(ctx.calls.some((command) => /load-buffer|paste-buffer|send-keys[^\n]*-l|send-keys[^\n]*Enter/u.test(command)))
        .toBe(false);
      if (ctx.oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = ctx.oldHome;
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
});

feature("Codex pane launch isolation", () => {
  unit("an explicitly authorized first bootstrap starts once without global latest", {
    when: ["building a new profile-2 Max pane", () => buildCodexLaunchCommand({
      profileHome: "/home/test/.config/agent/codex-profiles/2",
      model: "gpt-5.6-sol",
      effort: "max",
      allowFreshBootstrap: true,
    })],
    then: ["it is a single fresh codex invocation carrying the isolated settings", (command) => {
      expect(command).not.toContain("resume --last");
      expect(command).not.toContain("||");
      expect(command.match(/CODEX_HOME=/g)).toHaveLength(1);
      expect(command.match(/gpt-5\.6-sol/g)).toHaveLength(1);
      expect(command.match(/model_reasoning_effort="max"/g)).toHaveLength(1);
      expect(command).toContain("--yolo");
      expect(command).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    }],
  });

  unit("missing pane identity never silently falls back to fresh", {
    when: ["building without an exact id or bootstrap authorization", () => {
      try { return buildCodexLaunchCommand({ profileHome: "/home/test/.codex" }); }
      catch (error) { return error; }
    }],
    then: ["launch is blocked with the continuity precondition", (error) => {
      expect(error?.message).toMatch(/requires an exact pane session/);
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

  unit("a rollback launch resumes exactly one Codex session without a fresh fallback", {
    when: ["building an exact rollback command", () => buildCodexLaunchCommand({
      profileHome: "/home/test/.codex",
      resumeSessionId: "22222222-2222-4222-8222-222222222222",
      model: "gpt-5.6-sol",
      effort: "high",
    })],
    then: ["the command fails closed on that id", (command) => {
      expect(command).toContain("codex resume '22222222-2222-4222-8222-222222222222'");
      expect(command).not.toContain("--last");
      expect(command).not.toContain("||");
    }],
  });

  unit("unsafe rollback ids are rejected before shell construction", {
    when: ["building with shell syntax in the id", () => {
      try {
        buildCodexLaunchCommand({
          profileHome: "/home/test/.codex",
          resumeSessionId: "$(touch /tmp/no)",
        });
        return null;
      } catch (err) { return err; }
    }],
    then: ["validation fails", (error) => expect(error?.message).toMatch(/invalid Codex resume session id/)],
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

  unit("keeps managers out of the normal delivery path", {
    when: ["generating fresh agent hints", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-policy-test-"));
      paneDir(root, 0);
      const content = readFileSync(join(root, ".agents", "AGENTS.md"), "utf-8");
      rmSync(root, { recursive: true, force: true });
      return content;
    }],
    then: ["agents self-claim while managers observe only concrete exceptions", (content) => {
      expect(content).toContain("<!-- amux-hints-version: 1.25.2 -->");
      expect(content).toContain("Managers are sidecars, not gateways");
      expect(content).toContain("self-claim one READY");
      expect(content).toContain("Do not wake a fleet to look busy");
      expect(content).toContain("amux reconcile");
      expect(content).toMatch(/not a\s+staffing command/u);
      expect(content).toContain("No manager, memory note or older topology rule may narrow");
      expect(content).not.toContain("Broker panel routing is the default");
      expect(content).not.toContain("sole Claude");
      expect(content).not.toContain("broker owns dispatch");
    }],
  });

  unit("preserves Unicode in Swedish user-visible text and human quotes", {
    when: ["generating fresh agent hints", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-policy-test-"));
      paneDir(root, 0);
      const content = readFileSync(join(root, ".agents", "AGENTS.md"), "utf-8");
      rmSync(root, { recursive: true, force: true });
      return content;
    }],
    then: ["the policy forbids lossy transliteration instead of blaming storage", (content) => {
      expect(content).toMatch(/Human language stays UTF-8\s+end to end/u);
      expect(content).toContain("literal `åäö`");
      expect(content).toContain("byte-for-byte");
      expect(content).toContain("`amux-suggest`");
      expect(content).toContain("`--expect-file`");
      expect(content).toContain("Kommunikationsdisciplin");
      expect(content).toContain("Dagfilssektioner");
      expect(content).toContain("Skriv allt viktigt");
    }],
  });

  unit("keeps exhaustive visual suites out of the default PR path", {
    when: ["generating fresh agent hints", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-policy-test-"));
      paneDir(root, 0);
      const content = readFileSync(join(root, ".agents", "AGENTS.md"), "utf-8");
      rmSync(root, { recursive: true, force: true });
      return content;
    }],
    then: ["fast change-relevant gates are required and slow matrices are opt-in", (content) => {
      expect(content).toMatch(/run the change-relevant gate green after the\s+rebase/u);
      expect(content).toMatch(/fast change-relevant tests\/lint plus a bounded\s+manual proof/u);
      expect(content).toMatch(/Heavy CI,\s+full-repo suites, browser matrices and perf sweeps run only on explicit\s+human request or scheduled\/manual infrastructure/u);
      expect(content).toMatch(/A green pre-rebase check\s+proves nothing/u);
      expect(content).toMatch(/smallest relevant visual\s+scenario/u);
      expect(content).toMatch(/one representative screenshot/u);
      expect(content).toMatch(/one focused regression gate, not a slow blanket suite/u);
    }],
  });

  unit("makes reversible choices owner-decided instead of parked on the human", {
    when: ["generating fresh agent hints", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-policy-test-"));
      paneDir(root, 0);
      const content = readFileSync(join(root, ".agents", "AGENTS.md"), "utf-8");
      rmSync(root, { recursive: true, force: true });
      return content;
    }],
    then: ["the owner decides reversible work and asks only for real risk", (content) => {
      expect(content).toContain("Make reversible product calls yourself");
      expect(content).toMatch(/Ask first only for\s+irreversible, external-facing, money-spending or genuinely risky decisions/u);
    }],
  });

  unit("allows idle agents to self-claim without a manager round-trip", {
    when: ["generating fresh agent hints", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-policy-test-"));
      paneDir(root, 0);
      const content = readFileSync(join(root, ".agents", "AGENTS.md"), "utf-8");
      rmSync(root, { recursive: true, force: true });
      return content;
    }],
    then: ["READY work is self-claimable and managers are observers", (content) => {
      expect(content).toMatch(/capable idle agent may also self-claim one READY/u);
      expect(content).toContain("Managers are sidecars, not gateways");
      expect(content).toMatch(/do not need a manager round-trip to claim, update or\s+finish their own work/u);
      expect(content).toContain("A drained backlog is healthy idle");
    }],
  });

  unit("never stacks a new assignment onto an unfinished worker", {
    when: ["generating fresh agent hints", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-policy-test-"));
      paneDir(root, 0);
      const content = readFileSync(join(root, ".agents", "AGENTS.md"), "utf-8");
      rmSync(root, { recursive: true, force: true });
      return content;
    }],
    then: ["availability comes from process truth, not a missing lease", (content) => {
      expect(content).toContain("One active feature per agent");
      expect(content).toMatch(/working, waiting, blocked, in a modal, or merely\s+between tool calls/u);
      expect(content).toMatch(/A board lease alone does not prove a pane is\s+free/u);
      expect(content).toMatch(/Do not wake a fleet to look busy/u);
    }],
  });

  unit("puts merge and gated deploy inside the feature-owner flow", {
    when: ["generating fresh agent hints", () => {
      const root = mkdtempSync(join(tmpdir(), "agentmux-policy-test-"));
      paneDir(root, 0);
      const content = readFileSync(join(root, ".agents", "AGENTS.md"), "utf-8");
      rmSync(root, { recursive: true, force: true });
      return content;
    }],
    then: ["the owner self-merges and keeps required delivery in the same flow", (content) => {
      expect(content).toContain("One owner per feature, end to end");
      expect(content).toContain("Owners self-merge and self-deliver");
      expect(content).toMatch(/merged-but-undeployed feature remains open when\s+deployment is part of the task/u);
      expect(content).toMatch(/Irreversible or money-spending actions still\s+require human approval/u);
    }],
  });
});
