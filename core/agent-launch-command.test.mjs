import { expect, feature, unit } from "bdd-vitest";
import { buildClaudeLaunchCommand } from "./agent-launch-command.mjs";

feature("account-scoped Claude launch", () => {
  unit("binds the profile home while resuming the exact native session", {
    when: ["building a profile 2 restart", () => buildClaudeLaunchCommand({
      profileHome: "/profiles/claude-two",
      resumeSessionId: "11111111-1111-4111-8111-111111111111",
    })],
    then: ["auth and continuity are explicit in one command", (command) => {
      expect(command).toContain("CLAUDE_CONFIG_DIR='/profiles/claude-two'");
      expect(command).toContain("--resume '11111111-1111-4111-8111-111111111111'");
      expect(command).not.toContain("--continue");
    }],
  });
});
