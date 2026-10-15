import { component, expect, feature, unit } from "bdd-vitest";
import { buildClaudeLaunchCommand, buildCodexLaunchCommand } from "./agent-launch-command.mjs";
import { startCodexProcess } from "./codex-process-launch.mjs";

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
  unit("pins effort with the model on an exact Claude resume", {
    when: ["launching an existing session on Opus 5.5 high", () => buildClaudeLaunchCommand({
      model: "claude-opus-5-5", effort: "high",
      resumeSessionId: "11111111-1111-4111-8111-111111111111",
    })],
    then: ["the resumed process receives both choices", command => {
      expect(command).toContain("--model 'claude-opus-5-5'");
      expect(command).toContain("--effort 'high'");
      expect(command).toContain("--resume '11111111-1111-4111-8111-111111111111'");
    }],
  });
});

feature("Mattias's October 11 Codex launch policy", () => {
  unit("Astra is refused even for an exact historical resume", {
    when: ["building the stopped pane's old Astra launch", () => () => buildCodexLaunchCommand({
      profileHome: "/profiles/one", model: "gpt-6-astra", effort: "xhigh",
      resumeSessionId: "11111111-1111-4111-8111-111111111111" })],
    then: ["the launch names the Sol policy instead of starting Astra", build => expect(build).toThrow(/Mattias.*Sol/u)],
  });
});

feature("a Codex launch that only compacts", () => {
  component("the actual restart passes its configured directory into Codex", {
    when: ["restarting an exact session whose account may remember a probe directory", async () => {
      let command;
      await startCodexProcess({
        t: { runShell: async (_target, line) => { command = line; } },
        wait: async () => {}, target: "claw:.5", dir: "/project/.agents/5", profile: { home: "/two" },
        selected: { model: "gpt-6.1-sol", effort: "xhigh" }, previous: { model: "gpt-6.1-sol" },
        sessionId: "019f59a5-ec74-75d0-93d6-2da558dde937", remembered: {}, launchOptions: {},
        ready: async () => true, screen: async () => "› Ask Codex to do anything\n  GPT-6.1-Sol xhigh · /project/.agents/5",
        remember: () => {}, pin: () => {},
      });
      return command;
    }],
    then: ["the resume cannot choose a stale directory from the other account", command =>
      expect(command).toContain("--cd '/project/.agents/5'")],
  });
  unit("pins the pane directory even when the target profile saved another resume directory", {
    when: ["resuming the exact session in its configured pane", () => buildCodexLaunchCommand({
      profileHome: "/profiles/two", model: "gpt-6.1-sol", effort: "xhigh",
      cwd: "/project/.agents/5", resumeSessionId: "019f59a5-ec74-75d0-93d6-2da558dde937",
    })],
    then: ["Codex receives an explicit directory that takes precedence over its old registry", command => {
      expect(command).toContain("--cd '/project/.agents/5'");
      expect(command).toContain("resume '019f59a5-ec74-75d0-93d6-2da558dde937'");
    }],
  });
  unit("turns goals off for that launch", {
    when: ["building it", () => buildCodexLaunchCommand({ profileHome: "/p", model: "gpt-6.1-sol", resumeSessionId: "019f5b1d-16b8-7973-8bbf-414991667268", disableGoals: true })],
    then: ["the goal cannot start a turn before the compact", cmd => expect(cmd).toMatch(/codex resume '?019f5b1d-16b8-7973-8bbf-414991667268'? .*--disable goals/u)],
  });
});
