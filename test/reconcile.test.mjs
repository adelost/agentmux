import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createAgent } from "../agent.mjs";

const noop = () => Promise.resolve();

// Regression: 2026-06-11 reboot recovery. Reconcile respawned service panes
// with `respawn-pane -c .agents/N '<cmd>'` — wrong cwd (Makefile lives in the
// repo root) AND the command was the pane process, so a service that exited
// immediately closed its pane, renumbered the rest, and every later respawn
// missed ("can't find pane: N"). Services must mirror setupPanes: shell pane
// in the repo root + send-keys 'cd <root> && cmd'.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "agentmux-reconcile-"));
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, [
    "ai:",
    `  dir: ${root}`,
    "  panes:",
    "    - name: claude",
    "      cmd: claude --continue --dangerously-skip-permissions",
    "    - name: service-1",
    "      cmd: make ui",
    "",
  ].join("\n"));

  const tmuxExec = vi.fn(async (cmd) => {
    if (cmd.includes("list-panes")) return { stdout: "0: bash\n1: bash" };
    if (cmd.includes("display-message")) return { stdout: "bash" };
    return { stdout: "" };
  });

  const { reconcileSession } = createAgent({
    tmuxExec,
    run: vi.fn(async () => ({ stdout: "" })),
    tmuxSocket: "/tmp/test.sock",
    configPath,
    delay: noop,
    timeout: 300000,
  });

  const cleanup = () => rmSync(root, { recursive: true, force: true });
  return { reconcileSession, tmuxExec, root, cleanup };
}

feature("reconcileSession, service panes", () => {
  unit("respawns service pane as shell in repo root, then sends cd && cmd", {
    given: ["a session where all panes are idle shells", setup],
    when: [
      "reconciling the agent",
      async (ctx) => ({ summary: await ctx.reconcileSession("ai"), ...ctx }),
    ],
    then: [
      "service pane gets shell + send-keys, never cmd-as-pane-process",
      ({ summary, tmuxExec, root, cleanup }) => {
        const calls = tmuxExec.mock.calls.map(([cmd]) => cmd);

        const respawns = calls.filter((c) => c.includes("respawn-pane"));
        // Claude pane: bare shell in its own .agents/0.
        expect(respawns[0]).toContain(`-c '${join(root, ".agents", "0")}'`);
        // Service pane: bare shell in the REPO ROOT — no .agents/1, and no
        // trailing command argument (the pane must survive a dying service).
        expect(respawns[1]).toContain(`-c '${root}'`);
        expect(respawns[1]).not.toContain(".agents");
        expect(respawns[1]).not.toContain("make ui");

        const sends = calls.filter((c) => c.includes("send-keys"));
        expect(sends).toHaveLength(1);
        expect(sends[0]).toContain(`cd ${root} && make ui`);

        expect(summary.respawned).toHaveLength(2);
        cleanup();
      },
    ],
  });

  unit("reapplies tiled when pane count already matches config", {
    given: ["an existing two-pane session with no explicit layout", setup],
    when: ["reconciling without adding or removing panes", async (ctx) => ({
      ...ctx,
      summary: await ctx.reconcileSession("ai"),
    })],
    then: ["the shared tiled default is still applied", (ctx) => {
      const layoutCalls = ctx.tmuxExec.mock.calls
        .map(([cmd]) => cmd)
        .filter((cmd) => cmd.includes("select-layout"));
      expect(layoutCalls).toEqual([
        "tmux -S '/tmp/test.sock' select-layout -t 'ai' 'tiled'",
      ]);
      ctx.cleanup();
    }],
  });
});

function setupExtraPanes() {
  const root = mkdtempSync(join(tmpdir(), "agentmux-reconcile-extras-"));
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, [
    "claw:",
    `  dir: ${root}`,
    "  layout: tiled",
    "  panes:",
    "    - name: shell-1",
    "      cmd: bash",
    "    - name: shell-2",
    "      cmd: bash",
    "",
  ].join("\n"));

  const commands = ["bash", "bash", "bash", "node"];
  const tmuxExec = vi.fn(async (cmd) => {
    if (cmd.includes("has-session")) return { stdout: "" };
    if (cmd.includes("list-panes")) {
      return { stdout: commands.map((command, index) => `${index}: ${command}`).join("\n") };
    }
    if (cmd.includes("display-message")) {
      const pane = Number(cmd.match(/claw:\.(\d+)/)?.[1]);
      return { stdout: commands[pane] || "" };
    }
    if (cmd.includes("kill-pane")) {
      const pane = Number(cmd.match(/claw:\.(\d+)/)?.[1]);
      commands.splice(pane, 1);
    }
    return { stdout: "" };
  });

  const { reconcileSession } = createAgent({
    tmuxExec,
    run: vi.fn(async () => ({ stdout: "" })),
    tmuxSocket: "/tmp/test.sock",
    configPath,
    delay: noop,
    timeout: 300000,
  });

  return {
    reconcileSession,
    tmuxExec,
    commands,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

feature("reconcileSession, config shrink", () => {
  unit("removes only idle shell extras and preserves active extra processes", {
    given: ["two configured panes plus one idle shell and one active extra pane", setupExtraPanes],
    when: ["reconciling the smaller config", async (ctx) => ({
      ...ctx,
      summary: await ctx.reconcileSession("claw"),
    })],
    then: ["the idle extra is removed while the active extra remains visible", (ctx) => {
      const calls = ctx.tmuxExec.mock.calls.map(([cmd]) => cmd);
      expect(calls.filter((cmd) => cmd.includes("kill-pane"))).toEqual([
        "tmux -S '/tmp/test.sock' kill-pane -t 'claw:.2'",
      ]);
      expect(ctx.commands).toEqual(["bash", "bash", "node"]);
      expect(ctx.summary.removedExtras).toEqual([{ pane: 2, was: "bash" }]);
      expect(ctx.summary.extras).toBe(1);
      ctx.cleanup();
    }],
  });
});
