import { component, expect, feature, unit } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { buildGeminiLaunchCommand, createGeminiRuntime } from "./gemini-runtime.mjs";
import { captureGeminiPromptCursor, geminiPromptAccepted } from "./gemini-prompt-echo.mjs";
import { generateAgentsYaml, parseConfig } from "../sync.mjs";
import { createAgent } from "../agent.mjs";
import { isEngineProcess } from "./tui-stall-recovery.mjs";

const conversationId = "a4fade66-23c8-4002-81ea-94d4e2747db3";
const row = value => `${JSON.stringify(value)}\n`;
// Real agy 1.4.8 tmux capture of one shell-tool turn; account and workspace replaced.
const toolTurn = readFileSync(new URL("../test/fixtures/agy-1.4.8-tool-turn.txt", import.meta.url), "utf8");
const toolPrompt = ["Testvarv AGYPROBE1. Kör shell-kommandot: echo AGY_TOOL_OK",
  "Svara sedan med exakt en rad: AGY_REPLY_OK och ingenting mer.",
  `Fyllnadsrad för radbrytning: ${Array.from({ length: 120 }, (_, i) => `ord${i}`).join(" ")}`].join("\n");
const busyFooter = screen => screen.replace(/^\? for shortcuts/mu, "⣾  Generating...\nesc to cancel  ");
const tempHome = prefix => mkdtempSync(join(tmpdir(), prefix));

function fakeRuntime({ home, screens, previous = null }) {
  const writes = [], keys = [], values = new Map();
  if (previous) values.set("gemini_session_by_pane_v1", { "demo:0": previous });
  const state = { get: (key, fallback) => values.get(key) ?? fallback, set: (key, value) => values.set(key, value) };
  let tick = 0;
  const runtime = createGeminiRuntime({ home, state, wait: async () => {}, now: () => tick++,
    t: { sendLiteral: async (_, value) => writes.push(value), sendEnter: async () => keys.push("Enter") },
    paneDir: root => root, agentConfig: () => ({ panes: [{}] }), isAlreadyRunning: async () => false,
    isPaneDead: async () => false, respawnPane: async () => {}, assertEngineStartAllowed: async () => {},
    captureScreen: async () => (screens.length > 1 ? screens.shift() : screens[0]) });
  return { runtime, writes, keys, state };
}

feature("Gemini subscription pane on the Antigravity CLI", () => {
  unit("every launch auto-approves tools, strips paid keys and resumes only an exact conversation", {
    when: ["building fresh and resumed commands", () => [buildGeminiLaunchCommand(), buildGeminiLaunchCommand({ conversationId })]],
    then: ["YOLO is unconditional", ([fresh, resume]) => {
      for (const command of [fresh, resume]) {
        expect(command).toContain("'agy' --dangerously-skip-permissions");
        expect(command).toContain("env -u GEMINI_API_KEY -u GOOGLE_API_KEY");
      }
      expect(fresh).not.toContain("--conversation"); expect(resume).toContain(`--conversation '${conversationId}'`);
      expect(() => buildGeminiLaunchCommand({ conversationId: "latest" })).toThrow(/exact conversation UUID/u);
    }],
  });
  component("a first start accepts the workspace trust prompt and waits for the composer", {
    given: ["agy asking to trust the pane directory", () => fakeRuntime({ home: tempHome("amux-agy-home-"),
      screens: ["", "Do you trust the contents of this project?\n> Yes, I trust this folder", "", toolTurn] })],
    when: ["starting the pane", async ctx => ({ ...ctx, result: await ctx.runtime.startGemini("demo", "demo:.0", "/tmp/repo", 0) })],
    then: ["one fresh YOLO launch, trust confirmed, no conversation guessed", ({ writes, keys, result }) => {
      expect(writes).toHaveLength(1); expect(writes[0]).toContain("--dangerously-skip-permissions");
      expect(writes[0]).not.toContain("--conversation"); expect(keys).toEqual(["Enter", "Enter"]);
      expect(result).toEqual({ started: true, sessionId: null });
    }],
  });
  component("a restart resumes the conversation agy recorded for this pane's own workspace", {
    given: ["a pane AMUX started before and agy's workspace record", () => {
      const home = tempHome("amux-agy-home-");
      mkdirSync(join(home, ".gemini", "antigravity-cli", "cache"), { recursive: true });
      writeFileSync(join(home, ".gemini", "antigravity-cli", "cache", "last_conversations.json"),
        JSON.stringify({ "/tmp/repo": conversationId, "/tmp/other": "11111111-1111-4111-8111-111111111111" }));
      return { home, ...fakeRuntime({ home, screens: [toolTurn], previous: { sessionId: null, dir: "/tmp/repo" } }) };
    }],
    when: ["restarting", async ctx => ({ ...ctx, result: await ctx.runtime.startGemini("demo", "demo:.0", "/tmp/repo", 0) })],
    then: ["the exact conversation is resumed and persisted", ({ writes, result, state }) => {
      expect(writes[0]).toContain(`--conversation '${conversationId}'`); expect(result.sessionId).toBe(conversationId);
      expect(state.get("gemini_session_by_pane_v1")["demo:0"]).toEqual({ sessionId: conversationId, dir: "/tmp/repo" });
    }], cleanup: ctx => rmSync(ctx.home, { recursive: true, force: true }),
  });
  unit("a running agy process counts as a started engine, so delivery wake accepts it", {
    when: ["classifying the process tmux reports for a live Gemini pane", () => [isEngineProcess("agy"), isEngineProcess("bash")]],
    then: ["agy is running, the shell is not", result => expect(result).toEqual([true, false])],
  });
  unit("source config appends Gemini after the four existing engines, before utilities", {
    when: ["generating the mixed pane plan", () => {
      const { agents } = parseConfig("agents:\n  demo:\n    dir: /tmp/demo\n    claude: 1\n    codex: 1\n    kimi: 1\n    qwen: 1\n    gemini: 1\n    shells: 1\n");
      return yaml.load(generateAgentsYaml(agents, new Map(), new Map([["demo", "id"]]))).demo.panes;
    }], then: ["Gemini runs agy in its own coding slot", panes => {
      expect(panes[4]).toMatchObject({ engine: "gemini", cmd: "agy --dangerously-skip-permissions" }); expect(panes[5].name).toBe("shell-1");
    }],
  });
  component("the existing agent fallback reads the agy answer and busy footer from tmux", {
    given: ["a configured pane showing the real agy tool turn", () => {
      const root = tempHome("amux-agy-screen-");
      const configPath = join(root, "agents.yaml");
      writeFileSync(configPath, yaml.dump({ demo: { dir: root, panes: [{ cmd: "agy --dangerously-skip-permissions", engine: "gemini" }] } }));
      let screen = toolTurn;
      const agent = createAgent({ tmuxSocket: join(root, "unused.sock"), configPath,
        tmuxExec: async () => ({ stdout: screen }), run: async () => ({ stdout: "" }), delay: async () => {} });
      // The banner scrolls away in a long session; the configured engine still decides.
      return { root, agent, makeBusy: () => { screen = busyFooter(toolTurn.split("\n").slice(7).join("\n")); } };
    }], when: ["reading the idle reply and then active work", async ctx => {
      const reply = await ctx.agent.getResponseStreamWithRaw("demo", 0, toolPrompt);
      const idle = await ctx.agent.isBusy("demo", 0); ctx.makeBusy();
      return { reply, idle, busy: await ctx.agent.isBusy("demo", 0) };
    }], then: ["the wrapped prompt is gone and activity follows the footer", ({ reply, idle, busy }) => {
      expect(reply.items.filter(item => item.type === "text").map(item => item.content).join("\n")).toBe("AGY_REPLY_OK");
      expect(JSON.stringify(reply.items)).not.toContain("ord119");
      expect([idle, busy]).toEqual([false, true]);
    }], cleanup: ctx => rmSync(ctx.root, { recursive: true, force: true }),
  });
  component("only a new history row from this pane's workspace acknowledges a long prompt", {
    given: ["agy prompt history with an older identical prompt", () => {
      const home = tempHome("amux-agy-echo-");
      const file = join(home, ".gemini", "antigravity-cli", "history.jsonl");
      mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
      const prompt = "long prompt åäö\n".repeat(200), dir = "/tmp/repo";
      writeFileSync(file, row({ display: prompt, timestamp: 1, workspace: dir, conversationId }));
      return { home, file, prompt, dir, cursor: captureGeminiPromptCursor(prompt, { dir, home }) };
    }], when: ["checking before, after another workspace's row and after this pane's row", ctx => {
      const check = () => geminiPromptAccepted(ctx.prompt, { cursor: ctx.cursor, dir: ctx.dir, home: ctx.home });
      const old = check();
      appendFileSync(ctx.file, row({ display: ctx.prompt, timestamp: 2, workspace: "/tmp/other" }));
      const foreign = check();
      appendFileSync(ctx.file, row({ display: ctx.prompt, timestamp: 3, workspace: ctx.dir }));
      return [old, foreign, check()];
    }], then: ["old and foreign rows cannot release the delivery fence", result => expect(result).toEqual([false, false, true])],
    cleanup: ctx => rmSync(ctx.home, { recursive: true, force: true }),
  });
});
