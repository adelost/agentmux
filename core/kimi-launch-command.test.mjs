import { describe, expect, it } from "vitest";
import { dirname } from "node:path";
import { buildKimiLaunchCommand } from "./agent-launch-command.mjs";
import { createKimiAgentRuntime, isKimiComposerReady, kimiComposerHasCollapsedPaste } from "./kimi-agent-runtime.mjs";
import { kimiWorkDirKey } from "./kimi-workspace-trust.mjs";

const dirnameOf = (value) => dirname(value);

describe("Kimi launch continuity", () => {
  it("uses an absolute executable and exact persisted session", () => {
    const command = buildKimiLaunchCommand({
      executable: "/home/test/.kimi-code/bin/kimi",
      model: "kimi-code/k3",
      resumeSessionId: "session_12345678-1234-4234-9234-123456789abc",
      profileHome: "/profiles/kimi-two",
    });
    expect(command).toBe(
      "KIMI_CODE_HOME='/profiles/kimi-two' KIMI_MODEL_THINKING_EFFORT='max' " +
      "'/home/test/.kimi-code/bin/kimi' " +
      "--model 'kimi-code/k3' --auto --session " +
      "'session_12345678-1234-4234-9234-123456789abc'",
    );
  });

  it("refuses an unapproved fresh session", () => {
    expect(() => buildKimiLaunchCommand({
      executable: "/home/test/.kimi-code/bin/kimi",
      model: "kimi-code/k3",
    })).toThrow("fresh bootstrap was not authorized");
  });

  it("accepts the empty composer Kimi paints inside its TUI border", () => {
    expect(isKimiComposerReady(" ╭────╮\n │ >  │\n ╰────╯ ")).toBe(true);
    expect(isKimiComposerReady(" │ > manual draft │ ")).toBe(false);
  });

  it("recognizes Kimi's collapsed paste composer marker in all TUI forms", () => {
    expect(kimiComposerHasCollapsedPaste(" ╭──────────────╮\n │ > [paste #1] │\n ╰──────────────╯ ")).toBe(true);
    expect(kimiComposerHasCollapsedPaste(" > [paste #1 +24 lines] ")).toBe(true);
    expect(kimiComposerHasCollapsedPaste(" > [paste #2 900 chars] ")).toBe(true);
    // A marker is never an empty composer, and never a manual draft.
    expect(kimiComposerHasCollapsedPaste(" ╭────╮\n │ >  │\n ╰────╯ ")).toBe(false);
    expect(kimiComposerHasCollapsedPaste(" │ > manual draft │ ")).toBe(false);
    expect(isKimiComposerReady(" > [paste #1 +24 lines] ")).toBe(false);
  });

  it("uses ordinary Enter for an idle Kimi turn", async () => {
    const keys = [];
    const runtime = createKimiAgentRuntime({
      t: {
        sendKeys: async (target, key) => { keys.push([target, key]); },
      },
      wait: async () => {},
      paneDir: () => "/tmp/kimi-pane",
      agentConfig: () => ({ dir: "/tmp", panes: [] }),
      isBusy: async () => true,
      isPaneDead: async () => false,
      respawnPane: async () => {},
      isAlreadyRunning: async () => true,
      isShellProcess: () => false,
      captureScreen: async () => " ╭────╮\n │ >  │\n ╰────╯ ",
      promptAlreadyInComposer: async () => false,
    });

    await runtime.submitKimiPromptNow("ai:.7");
    expect(keys).toEqual([["ai:.7", "Enter"]]);
  });

  it("expands a collapsed active-turn paste before steering its exact text", async () => {
    const keys = [];
    let composer = " ╭──────────────╮\n │ > [paste #1] │\n ╰──────────────╯ ";
    const runtime = createKimiAgentRuntime({
      t: {
        sendKeys: async (target, key) => {
          keys.push([target, key]);
          if (key === "Enter") composer = " ╭────╮\n │ >  │\n ╰────╯ ";
        },
        captureScreen: async () => composer,
      },
      wait: async () => {},
      paneDir: () => "/tmp/kimi-pane",
      agentConfig: () => ({ dir: "/tmp", panes: [] }),
      isBusy: async () => true,
      isPaneDead: async () => false,
      respawnPane: async () => {},
      isAlreadyRunning: async () => true,
      isShellProcess: () => false,
      captureScreen: async () => " ╭────╮\n │ >  │\n ╰────╯ ",
      promptAlreadyInComposer: async () => false,
    });

    await expect(runtime.waitForKimiPromptReady("ai", 7)).resolves.toMatchObject({
      busy: true,
    });
    await runtime.submitKimiPromptNow("ai:.7", { busy: true });
    expect(keys).toEqual([
      ["ai:.7", "Enter"],
      ["ai:.7", "C-s"],
    ]);
  });
});

describe("Kimi workspace-trust pre-seed and modal backstop", () => {
  it("startKimi seeds the trust doc for the pane's launch dir before runShell", async () => {
    const { mkdtempSync, readFileSync, existsSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "kimi-home-"));
    const paneDir = mkdtempSync(join(tmpdir(), "kimi-pane-"));
    const shell = [];
    try {
      const runtime = createKimiAgentRuntime({
        t: {
          runShell: async (target, cmd) => { shell.push([target, cmd]); },
          sendKeys: async () => {},
          currentCommand: async () => "kimi-code",
          captureScreen: async () => " │ >  │ ",
        },
        state: null,
        wait: async () => {},
        paneDir: () => paneDir,
        agentConfig: () => ({ dir: dirnameOf(paneDir), panes: [] }),
        isBusy: async () => false,
        isPaneDead: async () => false,
        respawnPane: async () => {},
        isAlreadyRunning: async () => false,
        isShellProcess: () => false,
        captureScreen: async () => " │ >  │ ",
        promptAlreadyInComposer: async () => false,
      });
      await runtime.startKimi("ai", "ai:.7", dirnameOf(paneDir), 7, {
        profile: { home },
        resumeSessionId: "session_12345678-1234-4234-9234-123456789abc",
      });
      const key = kimiWorkDirKey(paneDir);
      const doc = join(home, "workspace-trust", key);
      expect(existsSync(doc)).toBe(true);
      expect(JSON.parse(readFileSync(doc, "utf-8")).root).toBe(paneDir);
      expect(shell.length).toBe(1);
      expect(shell[0][1]).toContain("--session");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(paneDir, { recursive: true, force: true });
    }
  });

  it("waitForKimiPromptReady answers a held modal once and proceeds", async () => {
    const keys = [];
    const modal = [
      " Trust this folder?",
      "  ❯ Trust this folder",
      "    Enable project MCP servers. Remembered for this folder.",
      "  Don't trust",
      "    Exit Kimi Code. Asked again next launch.",
    ].join("\n");
    let screen = modal;
    const runtime = createKimiAgentRuntime({
      t: {
        sendKeys: async (target, key) => {
          keys.push([target, key]);
          if (key === "Enter") screen = " │ >  │ ";
        },
      },
      wait: async () => {},
      paneDir: () => "/tmp/kimi-pane",
      agentConfig: () => ({ dir: "/tmp", panes: [] }),
      isBusy: async () => false,
      isPaneDead: async () => false,
      respawnPane: async () => {},
      isAlreadyRunning: async () => true,
      isShellProcess: () => false,
      captureScreen: async () => screen,
      promptAlreadyInComposer: async () => false,
    });
    await expect(runtime.waitForKimiPromptReady("ai", 7)).resolves.toMatchObject({ busy: false });
    expect(keys).toEqual([["ai:.7", "Enter"]]);
  });
});
