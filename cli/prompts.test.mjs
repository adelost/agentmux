import { describe, expect, it, vi } from "vitest";

vi.mock("./config.mjs", () => ({
  listAgents: () => [{ name: "skyvw", panes: [{}, {}], orchestrator: 0 }],
  findChannelForPane: () => null,
}));

import { answerPrompt, collectOpenPrompts, formatPromptRows } from "./prompts.mjs";

const PROMPT = `
   │ D=/home/adelost/lsrc/.artifacts/run-2026-09-15; rm -f $D/*.png
   Run shell command
 │ Dangerous rm operation on possibly-empty variable path: $D/*.png
 Do you want to proceed?
 ❯ 1. Yes
   2. No
 Esc to cancel · Tab to amend`;
const IDLE = "● Bash\n  done\n\n❯ ";

const fakeAgent = (screens) => ({
  capturePane: vi.fn(async (_n, pane) => screens[pane] ?? IDLE),
  typeLiteral: vi.fn(async () => {}),
  sendEnter: vi.fn(async () => {}),
});

describe("amux prompts", () => {
  it("lists the blocked pane with its age, its verdict and the command that ends it", async () => {
    const rows = await collectOpenPrompts({ agent: fakeAgent({ 1: PROMPT }), agentsYamlPath: "x.yaml", holdsKeptFiles: () => false });
    expect(rows.map((r) => r.paneKey)).toEqual(["skyvw:1"]);

    const ages = new Map([["skyvw:1", { firstSeenAt: "2026-09-15T10:00:00.000Z", orchestratorNotified: true }]]);
    const text = formatPromptRows(rows, { ages, at: Date.parse("2026-09-15T10:07:00.000Z") });
    expect(text).toContain("skyvw:1  waiting 7 min");
    expect(text).toContain("amux prompts answer skyvw -p 1 1");
    expect(text).toContain("owner: skyvw:0 (already told)");
  });

  it("says plainly when nothing is blocked", async () => {
    const rows = await collectOpenPrompts({ agent: fakeAgent({}), agentsYamlPath: "x.yaml", holdsKeptFiles: () => false });
    expect(formatPromptRows(rows)).toBe("No pane is waiting on a permission prompt.");
  });

  it("sends the choice only while that dialog is still on screen", async () => {
    const agent = fakeAgent({ 1: PROMPT });
    const result = await answerPrompt({ agent, agentName: "skyvw", pane: 1, choice: "1", settleMs: 0, sleep: async () => {} });
    expect(agent.typeLiteral).toHaveBeenCalledWith("skyvw", "1", 1);
    expect(agent.sendEnter).toHaveBeenCalledWith("skyvw", 1);
    expect(result.cleared).toBe(false);   // the fake pane keeps showing it: reported, not assumed
  });

  it("refuses to type into a pane whose dialog is gone", async () => {
    const agent = fakeAgent({});
    await expect(answerPrompt({ agent, agentName: "skyvw", pane: 1, choice: "1" }))
      .rejects.toThrow("no open permission prompt");
    expect(agent.typeLiteral).not.toHaveBeenCalled();
  });

  it("refuses an option the dialog does not offer", async () => {
    const agent = fakeAgent({ 1: PROMPT });
    await expect(answerPrompt({ agent, agentName: "skyvw", pane: 1, choice: "3" }))
      .rejects.toThrow("option 3 is not offered");
    expect(agent.typeLiteral).not.toHaveBeenCalled();
  });
});
