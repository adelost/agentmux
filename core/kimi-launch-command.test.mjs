import { describe, expect, it } from "vitest";
import { buildKimiLaunchCommand } from "./agent-launch-command.mjs";

describe("Kimi launch continuity", () => {
  it("uses an absolute executable and exact persisted session", () => {
    const command = buildKimiLaunchCommand({
      executable: "/home/test/.kimi-code/bin/kimi",
      model: "k3",
      resumeSessionId: "session_12345678-1234-4234-9234-123456789abc",
    });
    expect(command).toBe(
      "'/home/test/.kimi-code/bin/kimi' --model 'k3' --yolo --session " +
      "'session_12345678-1234-4234-9234-123456789abc'",
    );
  });

  it("refuses an unapproved fresh session", () => {
    expect(() => buildKimiLaunchCommand({
      executable: "/home/test/.kimi-code/bin/kimi",
      model: "k3",
    })).toThrow("fresh bootstrap was not authorized");
  });
});
