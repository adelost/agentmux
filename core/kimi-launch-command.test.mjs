import { describe, expect, it } from "vitest";
import { buildKimiLaunchCommand } from "./agent-launch-command.mjs";
import { isKimiComposerReady } from "./kimi-agent-runtime.mjs";

describe("Kimi launch continuity", () => {
  it("uses an absolute executable and exact persisted session", () => {
    const command = buildKimiLaunchCommand({
      executable: "/home/test/.kimi-code/bin/kimi",
      model: "kimi-code/k3",
      resumeSessionId: "session_12345678-1234-4234-9234-123456789abc",
    });
    expect(command).toBe(
      "KIMI_MODEL_THINKING_EFFORT='max' '/home/test/.kimi-code/bin/kimi' " +
      "--model 'kimi-code/k3' --yolo --session " +
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
});
