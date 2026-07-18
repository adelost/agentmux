import { feature, component, expect } from "bdd-vitest";
import { exec as execCb } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "util";
import yaml from "js-yaml";
import { createAgent } from "../agent.mjs";

const exec = promisify(execCb);

feature("fleet restart against an isolated tmux server", () => {
  component("kills and recreates the configured session and pane layout", {
    given: ["a throwaway thirteen-pane headless fleet", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-fleet-integration-"));
      const workspace = join(root, "workspace");
      const socket = join(root, "tmux.sock");
      const configPath = join(root, "agents.yaml");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(configPath, yaml.dump({
        fleet: {
          dir: workspace,
          layout: "tiled",
          panes: Array.from({ length: 13 }, (_, index) => ({
            name: `shell-${index}`, cmd: "bash", defer: true,
          })),
        },
        "skybar-canary": {
          dir: workspace,
          backend: "native",
          panes: [{ name: "claude", cmd: "native:claude" }],
        },
      }));
      const tmuxExec = (cmd) => exec(cmd, { timeout: 5000 });
      await tmuxExec(`tmux -S '${socket}' new-session -d -s fleet`);
      const before = (await tmuxExec(`tmux -S '${socket}' display-message -t fleet:.0 -p '#{pane_pid}'`)).stdout.trim();
      const agent = createAgent({
        tmuxSocket: socket,
        configPath,
        timeout: 10_000,
        tmuxExec,
        run: exec,
        delay: () => Promise.resolve(),
      });
      return { root, socket, tmuxExec, before, restartFleet: agent.restartFleet };
    }],
    when: ["the replacement bridge rebuilds the fleet", async ({ restartFleet, tmuxExec, socket }) => {
      const result = await restartFleet({ log: () => {} });
      const panes = (await tmuxExec(
        `tmux -S '${socket}' list-panes -t fleet -F '#{pane_index}|#{pane_width}|#{pane_height}'`,
      )).stdout.trim().split("\n").map((row) => {
        const [index, width, height] = row.split("|").map(Number);
        return { index, width, height };
      });
      const after = (await tmuxExec(`tmux -S '${socket}' display-message -t fleet:.0 -p '#{pane_pid}'`)).stdout.trim();
      const nativeTmuxExists = await tmuxExec(`tmux -S '${socket}' has-session -t skybar-canary`)
        .then(() => true, () => false);
      return { result, panes, after, nativeTmuxExists };
    }],
    then: ["the old process is gone, config is restored, and native sessions stay outside tmux", async ({ result, panes, after, nativeTmuxExists }, { root, socket, tmuxExec, before }) => {
      expect(result).toMatchObject({
        ok: true,
        configured: ["fleet"],
        stopped: ["fleet"],
        recreated: ["fleet"],
        codingPanes: 0,
        failures: [],
      });
      expect(panes.map(({ index }) => index)).toEqual(Array.from({ length: 13 }, (_, index) => index));
      expect(panes.every(({ width, height }) => width >= 60 && height >= 20)).toBe(true);
      expect(after).not.toBe(before);
      expect(nativeTmuxExists).toBe(false);
      await tmuxExec(`tmux -S '${socket}' kill-server`).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }],
  });

  component("refuses to kill the tmux session hosting its own bridge", {
    given: ["a bridge pane inside the configured fleet", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-fleet-guard-"));
      const workspace = join(root, "workspace");
      const socket = join(root, "tmux.sock");
      const configPath = join(root, "agents.yaml");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(configPath, yaml.dump({
        fleet: { dir: workspace, panes: [{ name: "shell", cmd: "bash", defer: true }] },
      }));
      const tmuxExec = (cmd) => exec(cmd, { timeout: 5000 });
      await tmuxExec(`tmux -S '${socket}' new-session -d -s fleet`);
      const paneId = (await tmuxExec(`tmux -S '${socket}' display-message -t fleet:.0 -p '#{pane_id}'`)).stdout.trim();
      const before = (await tmuxExec(`tmux -S '${socket}' display-message -t fleet:.0 -p '#{pane_pid}'`)).stdout.trim();
      const originalPane = process.env.TMUX_PANE;
      const originalTmux = process.env.TMUX;
      process.env.TMUX_PANE = paneId;
      process.env.TMUX = `${socket},123,0`;
      const agent = createAgent({
        tmuxSocket: socket,
        configPath,
        timeout: 10_000,
        tmuxExec,
        run: exec,
        delay: () => Promise.resolve(),
      });
      return { root, socket, tmuxExec, before, originalPane, originalTmux, restartFleet: agent.restartFleet };
    }],
    when: ["a full rebuild is attempted", async ({ restartFleet, tmuxExec, socket }) => {
      const result = await restartFleet({ log: () => {} });
      const after = (await tmuxExec(`tmux -S '${socket}' display-message -t fleet:.0 -p '#{pane_pid}'`)).stdout.trim();
      return { result, after };
    }],
    then: ["the fleet remains alive and the guard explains why", async ({ result, after }, context) => {
      expect(result.ok).toBe(false);
      expect(result.failures).toMatchObject([{ name: "fleet", stage: "guard" }]);
      expect(after).toBe(context.before);
      if (context.originalPane === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = context.originalPane;
      if (context.originalTmux === undefined) delete process.env.TMUX;
      else process.env.TMUX = context.originalTmux;
      await context.tmuxExec(`tmux -S '${context.socket}' kill-server`).catch(() => {});
      rmSync(context.root, { recursive: true, force: true });
    }],
  });
});
