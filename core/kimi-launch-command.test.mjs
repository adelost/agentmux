import { describe, expect, it } from "vitest";
import { buildKimiLaunchCommand } from "./agent-launch-command.mjs";
import { createKimiAgentRuntime, isKimiComposerReady } from "./kimi-agent-runtime.mjs";

describe("Kimi launch continuity", () => {
  it("uses an absolute executable and exact persisted session", () => {
    const command = buildKimiLaunchCommand({
      executable: "/home/test/.kimi-code/bin/kimi",
      model: "kimi-code/k3",
      resumeSessionId: "session_12345678-1234-4234-9234-123456789abc",
    });
    expect(command).toBe(
      "KIMI_MODEL_THINKING_EFFORT='max' '/home/test/.kimi-code/bin/kimi' " +
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
