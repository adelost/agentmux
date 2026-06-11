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
});
