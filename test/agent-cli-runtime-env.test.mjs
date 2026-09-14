import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "..");
// A clean home is not enough: a checkout's package .env may name the live
// AGENTS_YAML. On 2026-09-14 that rewrote the running bridge's fleet to this
// test's empty one, and the broker cancelled every queued claw:0 delivery.
// Each spawn therefore also points the package root at its temp directory.

describe("agent CLI runtime config ordering", () => {
  it("loads the operator todo path before evaluating command defaults", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-agent-cli-env-"));
    const home = join(root, "home");
    const todoPath = join(root, "operator-tasks.md");
    mkdirSync(join(home, ".agentmux"), { recursive: true });
    writeFileSync(join(home, ".agentmux", ".env"), [
      `AMUX_TODOS_PATH=${todoPath}`,
      "TMUX_SOCKET=/tmp/operator-agentmux.sock",
      "",
    ].join("\n"));
    writeFileSync(join(home, ".agentmux", "agentmux.yaml"),
      "agents:\n  demo:\n    dir: /tmp/demo\n    codex: 1\n");
    writeFileSync(todoPath, "# Tasks\n\n## Idag / snart\n- [ ] Operator path loaded <!-- id:1 -->\n");
    const env = { ...process.env, HOME: home, AGENTMUX_BRIDGE_DIR: root };
    delete env.AMUX_TODOS_PATH;
    delete env.AMUX_DISCORD_ENV;
    delete env.AGENTMUX_YAML;
    delete env.AGENTS_YAML;
    delete env.AGENT_CONFIG;
    delete env.TMUX_SOCKET;
    try {
      const result = spawnSync(process.execPath, [join(repo, "bin", "agent-cli.mjs"), "todo"], {
        encoding: "utf8",
        env,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Operator path loaded");

      const help = spawnSync(process.execPath, [join(repo, "bin", "agent-cli.mjs"), "help"], {
        encoding: "utf8",
        env,
      });
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain("Socket: /tmp/operator-agentmux.sock");
    }
    finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("adds the first project with the coding engine installed in a clean home", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-agent-cli-add-"));
    const home = join(root, "home");
    const fakeBin = join(root, "bin");
    mkdirSync(join(home, ".agentmux"), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(home, ".agentmux", "agentmux.yaml"), "agents: {}\n");
    writeFileSync(join(fakeBin, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(fakeBin, "codex"), 0o755);
    const env = { ...process.env, HOME: home, PATH: fakeBin, AGENTMUX_BRIDGE_DIR: root };
    for (const key of ["AMUX_DISCORD_ENV", "AGENTMUX_YAML", "AGENTS_YAML", "AGENT_CONFIG"]) {
      delete env[key];
    }
    try {
      const result = spawnSync(process.execPath, [
        join(repo, "bin", "agent-cli.mjs"), "add", "sample", join(root, "project"),
      ], { encoding: "utf8", env });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("(codex)");
      expect(readFileSync(join(home, ".agentmux", "agentmux.yaml"), "utf8"))
        .toContain("codex: 1");
      expect(readFileSync(join(home, ".agentmux", "agents.yaml"), "utf8"))
        .toContain("codex --yolo");
    }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
