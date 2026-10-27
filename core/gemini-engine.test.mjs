import { feature, unit, expect } from "bdd-vitest";
import yaml from "js-yaml";
import { generateAgentsYaml, generateChannelNames, parseConfig } from "../sync.mjs";
import * as dialects from "./dialects.mjs";
import { commandDialect } from "./pane-dialect.mjs";
import { sourceCodingPaneSlots } from "./source-pane-plan.mjs";
import { defaultCodingEngine } from "./default-engine.mjs";
import { isCodingPaneCommand, isEngineProcess } from "./tui-stall-recovery.mjs";
import { restartPaneEngine } from "../cli/restart-ready.mjs";
import { dreamPaneEngine } from "./dream-summarizer.mjs";

const source = (extra = "") => yaml.dump({ agents: { demo: {
  dir: "/tmp/demo", gemini: 1, geminiProfile: "google-login", ...(yaml.load(`demo:\n${extra}`)?.demo || {}),
} } });
const generated = text => {
  const { agents } = parseConfig(text);
  return { agents, runtime: yaml.load(generateAgentsYaml(agents, new Map(), new Map([["demo", "id"]]))).demo };
};
const screen = "Gemini CLI v0.65.0\n YOLO Ctrl+Y\n▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n *   Type your message or @path/to/file\n▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n workspace (/directory) /model Auto";

feature("Gemini source configuration and explicit capabilities", () => {
  unit("a Gemini-only category never silently creates a Claude pane", {
    when: ["parsing a fifth-engine-only category", () => generated(source())],
    then: ["the chosen profile survives and Auto sends no model flag", ({ agents, runtime }) => {
      expect(agents.get("demo")).toMatchObject({ claudeCount: 0, geminiCount: 1, geminiProfile: "google-login", geminiModel: null });
      expect(runtime.panes).toHaveLength(1);
      expect(runtime.panes[0]).toMatchObject({ engine: "gemini", geminiProfile: "google-login" });
      expect(runtime.panes[0].cmd).not.toMatch(/(?:^|\s)(?:-m|--model)\s/u);
    }],
  });

  unit("all five coding engines stay contiguous before utilities with the right channel and label", {
    when: ["generating a mixed category", () => generated(source("    claude: 1\n    codex: 1\n    kimi: 1\n    qwen: 1\n    services: [server]\n    shells: 1\n    labels: {4: Gemini-pilot}\n"))],
    then: ["Gemini is coding slot4, not a service or implicit Claude", ({ agents, runtime }) => {
      expect(sourceCodingPaneSlots(agents.get("demo")).map(slot => slot.engine)).toEqual(["claude", "codex", "kimi", "qwen", "gemini"]);
      expect(runtime.panes[4]).toMatchObject({ engine: "gemini", label: "Gemini-pilot" });
      expect(runtime.panes[5].name).toBe("service-1");
      expect(runtime.panes[6].name).toBe("shell-1");
      expect(generateChannelNames(agents)).toContainEqual({ agentName: "demo", pane: 4, dialect: "gemini", channelName: "demo-4-gemini" });
    }],
  });

  unit("an explicit Gemini model survives generation", {
    when: ["generating a named-model category", () => generated(source("    geminiModel: gemini-3.5-pro\n"))],
    then: ["model and descriptor agree", ({ runtime }) => {
      expect(runtime.panes[0].model).toBe("gemini-3.5-pro");
      expect(runtime.panes[0].cmd).toMatch(/-m '?gemini-3.5-pro'?/u);
    }],
  });

  for (const [name, extra, error] of [
    ["native backend", "    backend: native\n", /cannot define Gemini tmux panes/u],
    ["unsafe model", "    geminiModel: 'auto; echo nope'\n", /invalid geminiModel/u],
    ["escaping profile", "    geminiProfile: ../claude\n", /invalid Gemini profile/u],
    ["negative count", "    gemini: -1\n", /invalid gemini count/u],
  ]) unit(`${name} refuses before generation`, {
    when: ["parsing the invalid category", () => () => parseConfig(source(extra))],
    then: ["configuration does not silently change engines", parse => expect(parse).toThrow(error)],
  });

  unit("Gemini's observed asterisk composer is a literal marker, not a regex quantifier", {
    when: ["detecting the captured0.65 screen and matching a draft", () => ({
      dialect: dialects.detectDialect(screen), draft: () => dialects.matchesAnyPromptWithText("* hello"),
    })], then: ["the fifth dialect is recognized without breaking other matchers", ({ dialect, draft }) => {
      expect(dialect.name).toBe("gemini"); expect(draft()).toBe(true);
    }],
  });

  unit("compact support is explicit and Gemini is excluded while legacy support stays", {
    when: ["checking registered engine capabilities", () => ({
      gemini: dialects.supportsCompact?.("gemini"),
      old: ["claude", "codex", "kimi", "qwen"].map(name => dialects.supportsCompact?.(name)),
    })], then: ["registration never opts Gemini into maintenance", result => {
      expect(result.gemini).toBe(false); expect(result.old).toEqual([true, true, true, true]);
    }],
  });

  unit("routing and restart inventory keep Gemini out of Claude fallback", {
    when: ["resolving a configured Gemini command at each public boundary", () => ({
      dialect: commandDialect("/usr/bin/gemini --approval-mode yolo"),
      coding: isCodingPaneCommand("/usr/bin/gemini --approval-mode yolo"), process: isEngineProcess("gemini"),
      restart: restartPaneEngine({ engine: "gemini", cmd: "gemini" }),
      history: dreamPaneEngine({ engine: "gemini", cmd: "gemini" }),
    })], then: ["all consumers name the real engine", result => expect(result).toEqual({
      dialect: "gemini", coding: true, process: true, restart: "gemini", history: "gemini",
    })],
  });

  unit("starter discovery can name an installed Gemini without choosing a billing profile", {
    when: ["only Gemini is available", () => defaultCodingEngine({ env: { PATH: "/bin", HOME: "/fixture" }, exists: path => path === "/bin/gemini" })],
    then: ["Gemini is recognized, but startup still requires explicit profile validation", engine => expect(engine).toBe("gemini")],
  });
});
