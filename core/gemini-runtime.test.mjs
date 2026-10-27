import { component, feature, expect } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GEMINI_FORBIDDEN_ENV } from "./gemini-launch.mjs";
import { createGeminiAgentRuntime } from "./gemini-agent-runtime.mjs";
import { latestGeminiSessionIdentity } from "./gemini-pane-files.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const row = value => `${JSON.stringify(value)}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-gemini-runtime-"));
  const dir = join(root, "repo with 'quotes' and spaces");
  const profileRoot = join(root, "profiles");
  const profileHome = join(profileRoot, "google-login");
  const settingsPath = join(profileHome, ".gemini", "settings.json");
  const stateRoot = join(root, "state");
  mkdirSync(join(profileHome, ".gemini"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  const settings = { security: { auth: { selectedType: "oauth-personal" } }, advanced: { ignoreLocalEnv: true } };
  writeFileSync(settingsPath, JSON.stringify(settings));
  const config = { dir, panes: [{ engine: "gemini", geminiProfile: "google-login", model: null }] };
  const commands = [], kills = [], admissions = [];
  let clock = 0;
  const ctx = { root, dir, settingsPath, profileHome, stateRoot, settings, config, commands, kills, admissions,
    dirtyEnvironment: false, delayHook: false, busy: false, screen: "Gemini CLI v0.65.0\n *   Type your message or @path/to/file\n YOLO Ctrl+Y" };
  const attest = files => appendFileSync(files.eventsPath, row({ hook_event_name: "SessionStart", session_id: files.sessionId,
    generation: files.generation, cwd: dir, transcript_path: join(profileHome, ".gemini", "tmp", "repo", "chats", "session-2026-10-27T18-20-11111111.jsonl"),
    environment: Object.fromEntries(GEMINI_FORBIDDEN_ENV.map(name => [name, ctx.dirtyEnvironment && name === "GOOGLE_API_KEY"])) }));
  ctx.runtime = createGeminiAgentRuntime({
    t: { sendLiteral: async (_target, command) => {
      commands.push(command);
      const files = latestGeminiSessionIdentity(dir, { stateRoot, strict: true });
      ctx.prepared = files;
      if (!ctx.delayHook) attest(files);
    }, sendEnter: async () => {}, currentCommand: async () => "node", respawnPane: async (target, options) => kills.push({ target, ...options }) },
    wait: async ms => { clock += ms; if (ctx.delayHook && clock >= 500 && ctx.prepared) { attest(ctx.prepared); ctx.delayHook = false; } },
    now: () => clock, paneDir: () => dir, agentConfig: () => config, isBusy: async () => ctx.busy,
    isPaneDead: async () => false, respawnPane: async () => {}, isAlreadyRunning: async () => false,
    isShellProcess: () => true, captureScreen: async () => ctx.screen,
    assertEngineStartAllowed: async value => admissions.push(value),
    stateRoot, profileRoot, executable: process.execPath, readyTimeoutMs: 1000,
  });
  return ctx;
}
const cleanup = ctx => rmSync(ctx.root, { recursive: true, force: true });

feature("Gemini isolated lifecycle", () => {
  component("bootstrap and restart use the same exact session in a safely quoted directory", {
    given: ["a fresh explicitly selected Google profile", fixture],
    when: ["starting and then exactly restarting the pane", async ctx => {
      const first = await ctx.runtime.startGemini("demo", "demo:.0", ctx.dir, 0);
      const second = await ctx.runtime.restartGemini("demo", 0);
      return { first, second };
    }],
    then: ["no latest or fresh fallback crosses the restart", ({ first, second }, ctx) => {
      expect(first.identity.sessionId).toBe(second.sessionId);
      expect(ctx.commands[0]).toContain(`--session-id '${first.identity.sessionId}'`);
      expect(ctx.commands[1]).toContain(`--resume '${first.identity.sessionId}'`);
      expect(ctx.commands.every(command => command.startsWith("cd '"))).toBe(true);
      expect(ctx.commands[0]).toContain("'\\''quotes'\\''");
      expect(ctx.admissions).toHaveLength(2);
    }], cleanup,
  });

  component("an explicit configured session resumes even without an old runtime receipt", {
    given: ["a profile whose pane declares a resume UUID", () => { const ctx = fixture(); ctx.config.panes[0].resumeSessionId = sessionId; return ctx; }],
    when: ["starting the pane", ctx => ctx.runtime.startGemini("demo", "demo:.0", ctx.dir, 0)],
    then: ["the command is an exact resume", (_, ctx) => {
      expect(ctx.commands[0]).toContain(`--resume '${sessionId}'`); expect(ctx.commands[0]).not.toContain("--session-id");
    }], cleanup,
  });

  component("a visible composer waits for the later clean environment attestation", {
    given: ["a TUI that paints before SessionStart finishes", () => { const ctx = fixture(); ctx.delayHook = true; return ctx; }],
    when: ["starting the pane", ctx => ctx.runtime.startGemini("demo", "demo:.0", ctx.dir, 0)],
    then: ["only the bound receipt admits delivery", result => expect(result.identity.generation).toBeTruthy()], cleanup,
  });

  component("an auth variable acquired after startup stops the process before delivery", {
    given: ["a SessionStart child that sees a synthetic paid-auth variable", () => { const ctx = fixture(); ctx.dirtyEnvironment = true; return ctx; }],
    when: ["starting the pane", async ctx => {
      try { await ctx.runtime.startGemini("demo", "demo:.0", ctx.dir, 0); return null; } catch (error) { return error; }
    }],
    then: ["the unsafe process is killed and never published", (error, ctx) => {
      expect(error?.message).toMatch(/Gemini startup refused/u);
      expect(ctx.kills).toContainEqual(expect.objectContaining({ kill: true }));
      expect(latestGeminiSessionIdentity(ctx.dir, { stateRoot: ctx.stateRoot })).toBeNull();
    }], cleanup,
  });

  for (const problem of ["api-key-profile", "missing-profile", "profile-env", "gemini-env"]) component(`${problem} refuses before any process input`, {
    given: ["an unsafe or missing profile", () => {
      const ctx = fixture();
      if (problem === "api-key-profile") { ctx.settings.security.auth.selectedType = "gemini-api-key"; writeFileSync(ctx.settingsPath, JSON.stringify(ctx.settings)); }
      if (problem === "missing-profile") delete ctx.config.panes[0].geminiProfile;
      if (problem === "profile-env") writeFileSync(join(ctx.profileHome, ".env"), "fixture");
      if (problem === "gemini-env") { mkdirSync(join(ctx.dir, ".gemini")); writeFileSync(join(ctx.dir, ".gemini", ".env"), "fixture"); }
      return ctx;
    }],
    when: ["starting the pane", async ctx => {
      try { await ctx.runtime.startGemini("demo", "demo:.0", ctx.dir, 0); return null; } catch (error) { return error; }
    }], then: ["nothing was typed or launched", (error, ctx) => { expect(error).toBeInstanceOf(Error); expect(ctx.commands).toHaveLength(0); }], cleanup,
  });

  component("a busy pane cannot be exactly restarted", {
    given: ["a published pane still doing work", async () => {
      const ctx = fixture(); await ctx.runtime.startGemini("demo", "demo:.0", ctx.dir, 0); ctx.busy = true; return ctx;
    }],
    when: ["requesting restart", async ctx => {
      try { await ctx.runtime.restartGemini("demo", 0); return null; } catch (error) { return error; }
    }], then: ["the live process survives", (error, ctx) => { expect(error?.message).toMatch(/still working/u); expect(ctx.kills).toHaveLength(0); }], cleanup,
  });
});
