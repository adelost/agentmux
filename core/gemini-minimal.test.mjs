import { component, expect, feature, unit } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";
import { assertGeminiOAuthStart, buildGeminiLaunchCommand, createGeminiRuntime } from "./gemini-runtime.mjs";
import { captureGeminiPromptCursor, geminiPromptAccepted } from "./gemini-prompt-echo.mjs";
import { generateAgentsYaml, parseConfig } from "../sync.mjs";
import { createAgent } from "../agent.mjs";
import { geminiReplyTurn } from "./tmux-busy.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const row = value => `${JSON.stringify(value)}\n`;
const screen = prompt => `Gemini CLI v0.65.0\n▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n > ${prompt}\n▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n✦ GEMINI_MINIMAL_OK\n────────────────────\n YOLO Ctrl+Y\n▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄\n *   Type your message or @path/to/file\n▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀\n workspace (/directory) /model Auto\n /tmp/repo             no sandbox       Auto`;
const settings = { security: { auth: { selectedType: "oauth-personal" } } };

feature("minimal Gemini subscription launch and tmux observation", () => {
  unit("a submitted prompt box is removed without deleting reply quotations", {
    when: ["selecting the public part of the smallest captured turn", () => geminiReplyTurn("> PRIVATE BRIEF\n▀▀▀▀▀▀▀▀\n✦ PUBLIC ANSWER\n> quoted answer")],
    then: ["only the reply survives", result => expect(result).toBe("✦ PUBLIC ANSWER\n> quoted answer")],
  });
  unit("the normal CLI home refuses API authentication and missing settings", {
    when: ["checking the selected method without reading credentials", () => [
      () => assertGeminiOAuthStart({ settings: { security: { auth: { selectedType: "gemini-api-key" } } } }),
      () => assertGeminiOAuthStart({ settings: {} }),
    ]], then: ["both starts are refused", checks => checks.forEach(check => expect(check).toThrow(/oauth-personal/u))],
  });
  unit("Google OAuth is accepted without a second profile system", {
    when: ["checking a normal logged-in CLI", () => assertGeminiOAuthStart({ settings })],
    then: ["the guard admits it", result => expect(result).toEqual({ ok: true })],
  });
  unit("start and resume pin the exact UUID, yolo and trust policy without another home", {
    when: ["building both commands", () => [false, true].map(resume => buildGeminiLaunchCommand({ sessionId, resume }))],
    then: ["no key or arbitrary latest session is inherited", ([fresh, resume]) => {
      expect(fresh).toContain(`--session-id '${sessionId}'`); expect(resume).toContain(`--resume '${sessionId}'`);
      expect(fresh).toContain("--yolo --skip-trust"); expect(fresh).toContain("env -u GEMINI_API_KEY");
      expect(fresh).toContain("-u GEMINI_CLI_AUTH_OVERRIDE"); expect(fresh).not.toContain("GEMINI_CLI_HOME");
    }],
  });
  component("a refused normal-CLI profile receives no launch keystroke", {
    when: ["starting with API authentication", async () => {
      const writes = [];
      const runtime = createGeminiRuntime({ t: { sendLiteral: async value => writes.push(value) },
        state: { get: () => ({}), set: () => {} }, settings: { security: { auth: { selectedType: "gemini-api-key" } } } });
      let error;
      try { await runtime.startGemini("demo", "demo:.0", "/tmp", 0); } catch (caught) { error = caught; }
      return { writes, error };
    }], then: ["the guard fires before any input", ({ writes, error }) => { expect(error?.message).toMatch(/oauth-personal/u); expect(writes).toEqual([]); }],
  });
  unit("source config appends Gemini after the four existing engines, before utilities", {
    when: ["generating the mixed pane plan", () => {
      const { agents } = parseConfig("agents:\n  demo:\n    dir: /tmp/demo\n    claude: 1\n    codex: 1\n    kimi: 1\n    qwen: 1\n    gemini: 1\n    shells: 1\n");
      return yaml.load(generateAgentsYaml(agents, new Map(), new Map([["demo", "id"]]))).demo.panes;
    }], then: ["Gemini has its own coding slot", panes => {
      expect(panes[4]).toMatchObject({ engine: "gemini", cmd: "gemini --yolo --skip-trust" }); expect(panes[5].name).toBe("shell-1");
    }],
  });
  component("the existing agent fallback reads the Gemini answer and busy footer from tmux", {
    given: ["a synthetic configured pane with the captured real screen shape", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-gemini-screen-"));
      const configPath = join(root, "agents.yaml");
      writeFileSync(configPath, yaml.dump({ demo: { dir: root, panes: [{ cmd: "gemini --yolo", engine: "gemini" }] } }));
      let busy = false;
      const agent = createAgent({ tmuxSocket: join(root, "unused.sock"), configPath,
        tmuxExec: async () => ({ stdout: screen("HELLO_GEMINI") + (busy ? "\n ⠇ Working (esc to cancel, 1s)" : "") }),
        run: async () => ({ stdout: "" }), delay: async () => {} });
      return { root, agent, makeBusy: () => { busy = true; } };
    }], when: ["reading idle reply and then active work", async ctx => {
      const reply = await ctx.agent.getResponseStreamWithRaw("demo", 0, "HELLO_GEMINI");
      const idle = await ctx.agent.isBusy("demo", 0); ctx.makeBusy();
      return { reply, idle, busy: await ctx.agent.isBusy("demo", 0) };
    }], then: ["the answer is clean and activity follows the real signal", ({ reply, idle, busy }) => {
      expect(reply.items.filter(item => item.type === "text").map(item => item.content).join("\n")).toBe("GEMINI_MINIMAL_OK");
      expect([idle, busy]).toEqual([false, true]);
    }], cleanup: ctx => rmSync(ctx.root, { recursive: true, force: true }),
  });
  component("only a new exact native user event acknowledges a long prompt", {
    given: ["an exact native session, including the CLI's own setup post", () => {
      const home = mkdtempSync(join(tmpdir(), "amux-gemini-echo-"));
      const chats = join(home, ".gemini", "tmp", "fixture", "chats"); mkdirSync(chats, { recursive: true });
      const file = join(chats, "session-2026-10-27T19-00-11111111.jsonl");
      writeFileSync(file, row({ sessionId, kind: "main" }) + row({ type: "user", content: [{ text: "<session_context>setup</session_context>" }] }));
      const prompt = "long prompt åäö\n".repeat(200);
      const options = { home, sessionId };
      const cursor = captureGeminiPromptCursor(prompt, options);
      return { home, file, prompt, options, cursor };
    }], when: ["checking before and after the append", ctx => {
      const old = geminiPromptAccepted(ctx.prompt, { ...ctx.options, cursor: ctx.cursor });
      appendFileSync(ctx.file, row({ type: "user", content: [{ text: ctx.prompt }] }));
      const current = geminiPromptAccepted(ctx.prompt, { ...ctx.options, cursor: ctx.cursor });
      const next = captureGeminiPromptCursor(ctx.prompt, ctx.options);
      return [old, current, geminiPromptAccepted(ctx.prompt, { ...ctx.options, cursor: next })];
    }], then: ["old/setup records cannot release the delivery fence", result => expect(result).toEqual([false, true, false])],
    cleanup: ctx => rmSync(ctx.home, { recursive: true, force: true }),
  });
});
