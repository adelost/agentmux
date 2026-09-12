import { describe, expect, it, vi } from "vitest";

vi.mock("../cli/config.mjs", () => ({
  listAgents: () => [{ name: "lsrc", panes: [{}, {}] }],
  findChannelForPane: () => "chan-1",
}));

import { createPermissionWatchdog } from "./permission-watchdog.mjs";

const PROMPT = `
 Bash command

   │ Q=/mnt/q/Chathelper-traningsdata-2026-09-10/GEMMA-4-TEST/TRANINGSDATA; rm -f
   │ "$Q"/*.md && python3 export_review.py "$Q"

 Dangerous rm operation on possibly-empty variable path: "$Q"/*.md

 Do you want to proceed?
 ❯ 1. Yes
   2. No

 Esc to cancel · Tab to amend`;

const UNSAFE = PROMPT.replace('Q=/mnt/q/Chathelper-traningsdata-2026-09-10/GEMMA-4-TEST/TRANINGSDATA; ', "");
const IDLE = "● Bash\n  done\n\n❯ ";

function harness({ screens, autoAnswer = true }) {
  const agent = {
    capturePane: vi.fn(async (_n, pane) => screens[pane] ?? IDLE),
    typeLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
  };
  const discord = { send: vi.fn(async () => {}) };
  const notifyUser = vi.fn(async () => ({ sent: true }));
  const deliveryBroker = { runExclusive: vi.fn(async (_a, _p, fn) => fn()) };
  let t = 0;
  const wd = createPermissionWatchdog({
    agent, discord, notifyUser, deliveryBroker, agentsYamlPath: "x.yaml",
    config: { enabled: true, autoAnswer, pollMs: 1, promptAgeMs: 120_000 },
    log: () => {}, now: () => t,
  });
  return { wd, agent, discord, notifyUser, advance: (ms) => { t += ms; } };
}

describe("permission watchdog", () => {
  it("does nothing before the prompt is old enough, then answers the safe rm prompt once", async () => {
    const h = harness({ screens: { 0: PROMPT } });
    expect(await h.wd.tick()).toEqual([]);
    h.advance(60_000);
    expect(await h.wd.tick()).toEqual([]);
    h.advance(61_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:0", action: "answered" }]);
    expect(h.agent.typeLiteral).toHaveBeenCalledWith("lsrc", "1", 0);
    expect(h.agent.sendEnter).toHaveBeenCalledWith("lsrc", 0);
    expect(h.discord.send).toHaveBeenCalledTimes(1);
    expect(h.notifyUser).not.toHaveBeenCalled();
    h.advance(60_000);
    expect(await h.wd.tick()).toEqual([]);   // same prompt still on screen: never answered twice
  });

  it("alerts the human instead of answering an unsafe prompt", async () => {
    const h = harness({ screens: { 1: UNSAFE } });
    await h.wd.tick(); h.advance(121_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:1", action: "alerted" }]);
    expect(h.agent.typeLiteral).not.toHaveBeenCalled();
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
    expect(h.notifyUser.mock.calls[0][0]).toContain("lsrc:1");
    expect(h.notifyUser.mock.calls[0][0]).toContain("amux lsrc -p 1 -- 1");
  });

  it("only alerts when auto-answer is switched off", async () => {
    const h = harness({ screens: { 0: PROMPT }, autoAnswer: false });
    await h.wd.tick(); h.advance(121_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:0", action: "alerted" }]);
    expect(h.agent.typeLiteral).not.toHaveBeenCalled();
  });

  it("forgets a prompt that disappears and restarts the clock if it returns", async () => {
    const screens = { 0: PROMPT };
    const h = harness({ screens });
    await h.wd.tick(); h.advance(90_000);
    screens[0] = IDLE; await h.wd.tick();
    screens[0] = PROMPT; await h.wd.tick(); h.advance(90_000);
    expect(await h.wd.tick()).toEqual([]);
    h.advance(31_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:0", action: "answered" }]);
  });
});
