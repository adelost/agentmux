// inspect-pane: dialect resolution and the Kimi journal overlay, hermetic.

import { expect, feature, component } from "bdd-vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dialectFor, inspectPane } from "./inspect-pane.mjs";

const root = () => join(tmpdir(), `amux-inspect-pane-${process.pid}-${Math.random().toString(36).slice(2)}`);

const FROZEN_THINKING = [
  "  some earlier answer text",
  "",
  "⠦ thinking...",
  "K3 thinking: max",
  "> ",
].join("\n");

function kimiHome(paneDir, wireEvents) {
  const home = root();
  const sessionDir = join(home, "sessions", "wd_1_abc", "session_9b1f2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  mkdirSync(paneDir, { recursive: true });
  writeFileSync(
    join(home, "session_index.jsonl"),
    `${JSON.stringify({ sessionId: "session_9b1f2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d", sessionDir, workDir: paneDir })}\n`,
  );
  writeFileSync(
    join(sessionDir, "agents", "main", "wire.jsonl"),
    wireEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return { home, env: { KIMI_CODE_HOME: home } };
}

feature("dialectFor", () => {
  component("process name wins, cmd fallback resolves node, shells stay null", {
    given: ["panes and agents of each shape", () => ({
      kimiAgent: { panes: [{ cmd: "kimi --resume" }] },
      codexAgent: { panes: [{ cmd: "codex --model x" }] },
      claudeAgent: { panes: [{ cmd: "claude --continue" }] },
      shellAgent: { panes: [{ cmd: "bash" }] },
    })],
    when: ["resolving dialects", (ctx) => [
      dialectFor(ctx.kimiAgent, { index: 0, command: "kimi-code" }),
      dialectFor(ctx.codexAgent, { index: 0, command: "node" }),
      dialectFor(ctx.claudeAgent, { index: 0, command: "zsh" }),
      dialectFor(ctx.shellAgent, { index: 0, command: "bash" }),
    ]],
    then: ["exact mapping", (dialects) => {
      expect(dialects).toEqual(["kimi", "codex", "claude", null]);
    }],
  });
});

feature("inspectPane kimi overlay", () => {
  component("a frozen thinking frame with a busy Wire journal reports working", {
    given: ["a kimi pane frozen mid-thought", () => {
      const agentDir = join(root(), "agent");
      const workDir = join(agentDir, ".agents", "0");
      const { home } = kimiHome(workDir, [
        { type: "turn.prompt", prompt: "jobba" },
        { type: "context.append_loop_event", event: { type: "step.begin" } },
      ]);
      process.env.KIMI_CODE_HOME = home;
      return { home, agentDir };
    }],
    when: ["inspecting the pane", async (ctx) => {
      const agent = { name: "skydive", dir: ctx.agentDir, panes: [{ cmd: "kimi --resume" }] };
      const pane = { index: 0, command: "kimi-code" };
      const ctxFake = { agent: { capturePane: async () => FROZEN_THINKING } };
      try {
        return await inspectPane(ctxFake, agent, pane);
      } finally {
        delete process.env.KIMI_CODE_HOME;
        rmSync(ctx.home, { recursive: true, force: true });
      }
    }],
    then: ["status comes from the journal, never the frozen footer", (result) => {
      expect(result.status).toBe("working");
    }],
  });

  component("the same frozen frame after a done journal does not report working", {
    given: ["a kimi pane whose turn ended", () => {
      const agentDir = join(root(), "agent");
      const workDir = join(agentDir, ".agents", "0");
      const { home } = kimiHome(workDir, [
        { type: "turn.prompt", prompt: "jobba" },
        { type: "context.append_loop_event", event: { type: "step.begin" } },
        { type: "context.append_loop_event", event: { type: "step.end", finishReason: "end_turn" } },
      ]);
      process.env.KIMI_CODE_HOME = home;
      return { home, agentDir };
    }],
    when: ["inspecting the pane", async (ctx) => {
      const agent = { name: "skydive", dir: ctx.agentDir, panes: [{ cmd: "kimi --resume" }] };
      const pane = { index: 0, command: "kimi-code" };
      const ctxFake = { agent: { capturePane: async () => FROZEN_THINKING } };
      try {
        return await inspectPane(ctxFake, agent, pane);
      } finally {
        delete process.env.KIMI_CODE_HOME;
        rmSync(ctx.home, { recursive: true, force: true });
      }
    }],
    then: ["frozen scrollback is not permanent working", (result) => {
      expect(result.status).not.toBe("working");
    }],
  });
});
