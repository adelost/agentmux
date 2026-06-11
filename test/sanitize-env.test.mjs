import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createAgent } from "../agent.mjs";

const noop = () => Promise.resolve();

// Regression: 2026-06-11. The tmux server was started from inside a Claude
// Code session (Bash tool), so its global environment carried CLAUDECODE,
// CLAUDE_CODE_CHILD_SESSION and CLAUDE_CODE_SESSION_ID. Every pane inherited
// them, and every claude launched in a pane believed it was a child session
// of the launcher — and silently stopped persisting its transcript jsonl.
// No jsonl → no Discord mirroring → all agent replies invisible.
function setup({ globalEnv }) {
  const tmuxExec = vi.fn(async (cmd) => {
    if (cmd.includes("show-environment")) return { stdout: globalEnv };
    if (cmd.includes("has-session")) return { stdout: "" };
    return { stdout: "" };
  });

  const { sanitizeTmuxGlobalEnv } = createAgent({
    tmuxExec,
    run: vi.fn(async () => ({ stdout: "" })),
    tmuxSocket: "/tmp/test.sock",
    configPath: "/tmp/test-agents.yaml",
    delay: noop,
    timeout: 300000,
  });

  return { sanitizeTmuxGlobalEnv, tmuxExec };
}

feature("sanitizeTmuxGlobalEnv", () => {
  unit("unsets leaked Claude session vars, leaves everything else", {
    given: [
      "a tmux global env polluted by a parent Claude session",
      () => setup({
        globalEnv: [
          "AI_AGENT=claude-code_2-1-172_agent",
          "CLAUDECODE=1",
          "CLAUDE_CODE_CHILD_SESSION=1",
          "CLAUDE_CODE_ENTRYPOINT=cli",
          "CLAUDE_CODE_SESSION_ID=ef18fe44-dead-beef",
          "CLAUDE_EFFORT=high",
          "PATH=/usr/bin",
          "CLAUDE_CONFIG_DIRISH=keepme", // prefix-similar but not CLAUDE_CODE_*
        ].join("\n"),
      }),
    ],
    when: [
      "sanitizing",
      async (ctx) => { await ctx.sanitizeTmuxGlobalEnv(); return ctx; },
    ],
    then: [
      "exactly the six leaked vars get set-environment -g -u",
      ({ tmuxExec }) => {
        const unsets = tmuxExec.mock.calls
          .map(([cmd]) => cmd)
          .filter((c) => c.includes("set-environment -g -u"));
        const names = unsets.map((c) => c.match(/-u '([^']+)'/)[1]).sort();
        expect(names).toEqual([
          "AI_AGENT",
          "CLAUDECODE",
          "CLAUDE_CODE_CHILD_SESSION",
          "CLAUDE_CODE_ENTRYPOINT",
          "CLAUDE_CODE_SESSION_ID",
          "CLAUDE_EFFORT",
        ]);
      },
    ],
  });

  unit("does nothing on a clean environment", {
    given: [
      "a tmux global env without Claude vars",
      () => setup({ globalEnv: "PATH=/usr/bin\nHOME=/home/x" }),
    ],
    when: [
      "sanitizing",
      async (ctx) => { await ctx.sanitizeTmuxGlobalEnv(); return ctx; },
    ],
    then: [
      "no set-environment calls are made",
      ({ tmuxExec }) => {
        const unsets = tmuxExec.mock.calls
          .map(([cmd]) => cmd)
          .filter((c) => c.includes("set-environment"));
        expect(unsets).toHaveLength(0);
      },
    ],
  });
});
