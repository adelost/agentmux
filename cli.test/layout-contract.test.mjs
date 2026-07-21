import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import yaml from "js-yaml";
import { ensureAndAttach } from "../cli/tmux.mjs";
import { generateAgentsYaml, parseConfig } from "../sync.mjs";

function layoutFixture({ source, failLayout = false }) {
  const root = mkdtempSync(join(tmpdir(), "amux-layout-contract-"));
  const configPath = join(root, "agents.yaml");
  const agents = parseConfig(source).agents;
  const generated = generateAgentsYaml(
    agents,
    new Map(),
    new Map([...agents.keys()].map((name) => [name, `${name}-id`])),
  );
  writeFileSync(configPath, generated);

  const commands = [];
  const readyPanes = [];
  const paneCount = agents.get("skybar").panes
    + agents.get("skybar").services.length
    + agents.get("skybar").shells;
  const paneRows = Array.from({ length: paneCount }, (_, index) => `${index}|80x24|bash`).join("\n");
  const ctx = {
    agent: {
      ensureReady: async (_name, pane) => readyPanes.push(pane),
    },
    tmux: async (command) => {
      commands.push(command);
      if (command.startsWith("list-panes")) return { stdout: paneRows };
      if (failLayout && command.startsWith("select-layout")) throw new Error("tmux rejected layout");
      return { stdout: "" };
    },
  };

  return {
    root,
    configPath,
    generated: yaml.load(generated),
    ctx,
    commands,
    readyPanes,
  };
}

const sourceWithoutLayout = `
guild: "1"
agents:
  skybar:
    dir: /tmp/skybar
    claude: 2
    codex: 1
    services:
      - npm run dev
    shells: 1
`;

const sourceWithKimi = sourceWithoutLayout.replace(
  "    codex: 1",
  "    codex: 1\n    kimi: 1",
);

feature("tmux layout contract", () => {
  component("defaults the complete sync-to-attach path to tiled", {
    given: ["a mixed Claude, Codex, service and shell fleet without an explicit layout", () =>
      layoutFixture({ source: sourceWithoutLayout })],
    when: ["sync output is attached", async (fixture) => {
      await ensureAndAttach(fixture.ctx, "skybar", fixture.configPath);
      return fixture;
    }],
    then: ["the generated config and attach command both select tiled", (fixture) => {
      expect(fixture.generated.skybar.layout).toBe("tiled");
      expect(fixture.commands).toContain("select-layout -t 'skybar' 'tiled'");
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });

  component("surfaces a tmux layout failure instead of attaching silently", {
    given: ["a valid tiled config whose tmux layout command fails", () =>
      layoutFixture({ source: sourceWithoutLayout, failLayout: true })],
    when: ["attaching", async (fixture) => {
      let error = null;
      try {
        await ensureAndAttach(fixture.ctx, "skybar", fixture.configPath);
      } catch (cause) {
        error = cause;
      }
      return { ...fixture, error };
    }],
    then: ["the infrastructure error reaches the caller", (fixture) => {
      expect(fixture.error?.message).toContain("tmux rejected layout");
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });

  component("starts only the primary coding pane when a session is attached", {
    given: ["a mixed fleet containing Claude, Codex and Kimi", () =>
      layoutFixture({ source: sourceWithKimi })],
    when: ["the recreated session is attached", async (fixture) => {
      await ensureAndAttach(fixture.ctx, "skybar", fixture.configPath);
      return fixture;
    }],
    then: ["Claude zero is ready while later Claude, Codex and Kimi panes stay sleeping", (fixture) => {
      expect(fixture.readyPanes).toEqual([0]);
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });
});
