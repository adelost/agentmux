import { feature, unit, expect } from "bdd-vitest";
import { driveCodexStatus, formatCodexStatus, parseCodexStatus } from "./codex-status.mjs";

const STATUS = `
/status

╭──────────────────────────────────────────────────────────────────────────╮
│  >_ OpenAI Codex (v0.144.1)                                             │
│                                                                          │
│ Visit https://chatgpt.com/codex/settings/usage for up-to-date            │
│ information on rate limits and credits                                   │
│                                                                          │
│  Model:                       gpt-5.6-sol (reasoning max, summaries auto)│
│  Directory:                   ~/lsrc/.agents/5                           │
│  Permissions:                 Full Access                                │
│  Agents.md:                   <none>                                     │
│  Account:                     mattias@example.com (Pro)                  │
│  Collaboration mode:          Default                                    │
│  Session:                     019f5181-95b3-7e72-978b-1e74a246a86a       │
│                                                                          │
│  Context window:              60% left (149K used / 353K)                │
│  5h limit:                    [████████████████░░░░] 82% left (resets 17:13)│
│  Weekly limit:                [█████████████░░░░░░░] 65% left (resets 17:02 on 18 Jul)│
│  GPT-5.3-Codex-Spark limit:                                              │
│  5h limit:                    [████████████████████] 100% left (resets 17:15)│
│  Weekly limit:                [████████████████████] 100% left (resets 12:15 on 19 Jul)│
│  Warning:                     limits may be stale - run /status again shortly.│
╰──────────────────────────────────────────────────────────────────────────╯

› Explain this codebase
`;

feature("native Codex status parsing", () => {
  unit("extracts account, effective model, context and both quota families", {
    when: ["parsing the live 0.144.1 box", () => parseCodexStatus(STATUS)],
    then: ["all high-value fields are structured", (status) => {
      expect(status.version).toBe("0.144.1");
      expect(status.account).toBe("mattias@example.com (Pro)");
      expect(status.model).toMatchObject({ id: "gpt-5.6-sol", effort: "max", summaries: "auto" });
      expect(status.context).toMatchObject({ percentLeft: 60, used: "149K", total: "353K" });
      expect(status.limits.primary5h).toMatchObject({ percentLeft: 82, resets: "17:13" });
      expect(status.limits.weekly).toMatchObject({ percentLeft: 65, resets: "17:02 on 18 Jul" });
      expect(status.limits.spark5h.percentLeft).toBe(100);
      expect(status.limits.sparkWeekly.percentLeft).toBe(100);
      expect(status.warning).toMatch(/stale/);
    }],
  });

  unit("newest box wins when scrollback contains an older account", {
    given: ["two status boxes", () => `${STATUS.replace("mattias@example.com", "old@example.com")}\n${STATUS}`],
    when: ["parsing", (text) => parseCodexStatus(text)],
    then: ["the latest account wins", (status) => expect(status.account).toBe("mattias@example.com (Pro)")],
  });

  unit("a clipped header without fields fails honestly", {
    when: ["parsing a narrow fragment", () => parseCodexStatus("│ >_ OpenAI Codex (v0.144.1) │")],
    then: ["null", (status) => expect(status).toBeNull()],
  });

  unit("Discord formatter is compact but includes resets and profile", {
    given: ["parsed status", () => parseCodexStatus(STATUS)],
    when: ["formatting", (status) => formatCodexStatus(status, { agentName: "claw", pane: 11, profile: "2" })],
    then: ["key fields remain visible", (text) => {
      expect(text).toContain("Codex-profil **2**");
      expect(text).toContain("mattias@example.com (Pro)");
      expect(text).toContain("82% kvar");
      expect(text).toContain("18 Jul");
      expect(text).toContain("Spark");
    }],
  });
});

function fakeAgent(frames, { busy = false } = {}) {
  let index = 0;
  const keys = [];
  return {
    keys,
    isBusy: async () => busy,
    capturePane: async () => frames[Math.min(index++, frames.length - 1)],
    typeLiteral: async (_name, value) => keys.push(value),
    clearInputLine: async () => keys.push("<clear>"),
    sendEnter: async () => keys.push("<enter>"),
    sendEscape: async () => keys.push("<esc>"),
  };
}

const noSleep = () => Promise.resolve();

feature("driveCodexStatus", () => {
  unit("verifies command palette, submits and returns parsed native status", {
    given: ["an idle pane through the status command", () => ({
      agent: fakeAgent([
        "\n› Explain this codebase\n",
        "\n› Explain this codebase\n",
        "\n  /status  show current session configuration and token usage\n",
        STATUS,
      ]),
    })],
    when: ["driving", ({ agent }) => driveCodexStatus({
      agent, name: "claw", pane: 11, sleep: noSleep, timeoutMs: 100,
    })],
    then: ["status and exact keystrokes", (result, { agent }) => {
      expect(result.ok).toBe(true);
      expect(result.status.account).toContain("mattias@example.com");
      expect(agent.keys).toEqual(["/status", "<enter>"]);
    }],
  });

  unit("unknown palette fails before Enter", {
    given: ["a changed Codex UI", () => ({
      agent: fakeAgent(["\n› Explain this codebase\n", "\nunknown palette\n"]),
    })],
    when: ["driving", ({ agent }) => driveCodexStatus({
      agent, name: "claw", pane: 11, sleep: noSleep, timeoutMs: 100,
    })],
    then: ["fail closed", (result, { agent }) => {
      expect(result).toMatchObject({ ok: false, stage: "compose" });
      expect(agent.keys).toEqual(["/status", "<clear>", "<esc>"]);
      expect(agent.keys).not.toContain("<enter>");
    }],
  });

  unit("does not accept an old status box while the new command is still below it", {
    given: ["scrollback containing an old box, then a submitted command with no new box", () => {
      const old = STATUS;
      const agent = fakeAgent([
        `${old}\n› Explain this codebase\n`,
        `${old}\n› Explain this codebase\n`,
        "\n  /status  show current session configuration and token usage\n",
        "\n  /status  show current session configuration and token usage\n",
        `${old}\n/status\n› Explain this codebase\n`,
      ]);
      return { agent };
    }],
    when: ["driving", ({ agent }) => driveCodexStatus({
      agent, name: "claw", pane: 11, sleep: noSleep, timeoutMs: 5,
    })],
    then: ["it times out instead of returning stale account data", (result) => {
      expect(result).toMatchObject({ ok: false, stage: "parse" });
    }],
  });
});
