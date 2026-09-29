import { describe, expect, it, vi } from "vitest";

vi.mock("../cli/config.mjs", () => ({
  listAgents: () => [{ name: "lsrc", dir: "/tmp/lsrc", panes: [{}, {}], orchestrator: 0 }],
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

function harness({ screens, autoAnswer = true, sessionIds = { 0: "session-0", 1: "session-1" }, capture = null }) {
  const decisions = [];
  const snapshots = [];
  const beats = [];
  const agent = {
    capturePane: vi.fn(capture ?? (async (_n, pane) => screens[pane] ?? IDLE)),
    typeLiteral: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {}),
    sendOnly: vi.fn(async () => ({ submitted: true })),
  };
  const discord = { send: vi.fn(async () => {}) };
  const notifyUser = vi.fn(async () => ({ sent: true }));
  const deliveryBroker = { runExclusive: vi.fn(async (_a, _p, fn) => fn()) };
  let t = 0;
  const wd = createPermissionWatchdog({
    agent, discord, notifyUser, deliveryBroker, agentsYamlPath: "x.yaml",
    config: { enabled: true, autoAnswer, pollMs: 1, answerAgeMs: 10_000, promptAgeMs: 120_000, humanAgeMs: 600_000 },
    holdsKeptFiles: () => false,
    sessionIdentity: (_agentConfig, pane) => sessionIds[pane] ?? null,
    recordDecision: (line) => decisions.push(JSON.parse(line)),
    publishOpenPrompts: (text) => snapshots.push(JSON.parse(text)),
    beat: (metrics) => beats.push(metrics),
    captureTimeoutMs: 50,
    log: () => {}, now: () => t,
  });
  return { wd, agent, discord, notifyUser, decisions, snapshots, beats, advance: (ms) => { t += ms; } };
}

describe("permission watchdog", () => {
  it("answers the safe rm prompt once after the short answer delay, not after two minutes", async () => {
    const h = harness({ screens: { 0: PROMPT } });
    expect(await h.wd.tick()).toEqual([]);
    h.advance(5_000);
    expect(await h.wd.tick()).toEqual([]);
    h.advance(6_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:0", action: "answered" }]);
    expect(h.agent.typeLiteral).toHaveBeenCalledWith("lsrc", "1", 0);
    expect(h.agent.sendEnter).toHaveBeenCalledWith("lsrc", 0);
    expect(h.discord.send).toHaveBeenCalledTimes(1);
    expect(h.notifyUser).not.toHaveBeenCalled();
    h.advance(60_000);
    expect(await h.wd.tick()).toEqual([]);   // same prompt still on screen: never answered twice
  });

  it("waits the full alert delay before alerting about an unsafe prompt", async () => {
    const h = harness({ screens: { 1: UNSAFE } });
    await h.wd.tick(); h.advance(60_000);
    expect(await h.wd.tick()).toEqual([]);
  });

  it("routes an unsafe prompt to the configured orchestrator, then alerts the human if it remains open", async () => {
    const h = harness({ screens: { 1: UNSAFE } });
    await h.wd.tick(); h.advance(121_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:1", action: "escalated-orchestrator" }]);
    expect(h.agent.sendOnly).toHaveBeenCalledWith("lsrc", expect.stringContaining("lsrc:1"), 0);
    expect(h.agent.typeLiteral).not.toHaveBeenCalled();
    expect(h.notifyUser).not.toHaveBeenCalled();
    h.advance(60_000);
    expect(await h.wd.tick()).toEqual([]);
    expect(h.agent.sendOnly).toHaveBeenCalledTimes(1);
    h.advance(420_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:1", action: "escalated-human" }]);
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
    expect(h.notifyUser.mock.calls[0][0]).toContain("lsrc:1");
    expect(h.notifyUser.mock.calls[0][0]).toContain("amux lsrc -p 1 -- 1");
  });

  it("escalates a wrapped live question without typing Yes into the pane", async () => {
    const narrow = PROMPT.replace("Do you want to proceed?", "Do you want to\n proceed?");
    const h = harness({ screens: { 1: narrow } });
    await h.wd.tick(); h.advance(11_000);
    expect(await h.wd.tick()).toEqual([]);
    expect(h.agent.typeLiteral).not.toHaveBeenCalled();
    h.advance(110_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:1", action: "escalated-orchestrator" }]);
    expect(h.decisions[0].why).toContain("lsrc:0 owns the decision");
    expect(h.agent.typeLiteral).not.toHaveBeenCalled();
  });

  it("routes instead of answering when auto-answer is switched off", async () => {
    const h = harness({ screens: { 0: PROMPT }, autoAnswer: false });
    await h.wd.tick(); h.advance(121_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:0", action: "escalated-human" }]);
    expect(h.agent.typeLiteral).not.toHaveBeenCalled();
  });

  it("refuses to answer when the prompt changes under the delivery lock", async () => {
    const screens = { 0: PROMPT };
    const h = harness({ screens });
    await h.wd.tick(); h.advance(11_000);
    h.agent.capturePane.mockImplementationOnce(async () => PROMPT)
      .mockImplementationOnce(async () => UNSAFE);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:0", action: "stale" }]);
    expect(h.agent.typeLiteral).not.toHaveBeenCalled();
    expect(h.agent.sendEnter).not.toHaveBeenCalled();
  });

  it("refuses to answer when the pane session changes under the delivery lock", async () => {
    const sessionIds = { 0: "session-a", 1: "session-1" };
    const h = harness({ screens: { 0: PROMPT }, sessionIds });
    let paneZeroCaptures = 0;
    h.agent.capturePane.mockImplementation(async (_name, pane) => {
      if (pane !== 0) return IDLE;
      paneZeroCaptures += 1;
      if (paneZeroCaptures === 3) sessionIds[0] = "session-b";
      return PROMPT;
    });
    await h.wd.tick(); h.advance(11_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:0", action: "stale" }]);
    expect(h.agent.typeLiteral).not.toHaveBeenCalled();
    expect(h.agent.sendEnter).not.toHaveBeenCalled();
  });

  it("never auto-answers when the current pane session is unknown", async () => {
    const h = harness({ screens: { 0: PROMPT }, sessionIds: {} });
    await h.wd.tick(); h.advance(11_000);
    expect(await h.wd.tick()).toEqual([]);
    expect(h.agent.typeLiteral).not.toHaveBeenCalled();
    h.advance(110_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:0", action: "escalated-human" }]);
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
  });

  it("falls back to the human when the configured owner cannot receive the prompt", async () => {
    const h = harness({ screens: { 1: UNSAFE } });
    h.agent.sendOnly.mockRejectedValueOnce(new Error("owner quota stopped"));
    await h.wd.tick(); h.advance(121_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:1", action: "escalated-human" }]);
    expect(h.agent.sendOnly).toHaveBeenCalledTimes(1);
    expect(h.notifyUser).toHaveBeenCalledTimes(1);
  });

  it("forgets a prompt that disappears and restarts the clock if it returns", async () => {
    const screens = { 0: PROMPT };
    const h = harness({ screens });
    await h.wd.tick(); h.advance(8_000);
    screens[0] = IDLE; await h.wd.tick();
    screens[0] = PROMPT; await h.wd.tick(); h.advance(8_000);
    expect(await h.wd.tick()).toEqual([]);
    h.advance(3_000);
    expect(await h.wd.tick()).toEqual([{ paneKey: "lsrc:0", action: "answered" }]);
  });
});

describe("the watchdog's own record", () => {
  it("writes one decision line per outcome, so the file answers whether it acted", async () => {
    const screens = { 0: PROMPT, 1: UNSAFE };
    const h = harness({ screens });
    await h.wd.tick(); h.advance(11_000); await h.wd.tick();       // safe one answered
    screens[0] = IDLE;                                              // the answer closed that dialog
    h.advance(110_000); await h.wd.tick();                          // unsafe one to the owner
    h.advance(600_000); await h.wd.tick();                          // still open: the human

    expect(h.decisions.map((d) => [d.pane, d.action])).toEqual([
      ["lsrc:0", "answered"],
      ["lsrc:1", "escalated-orchestrator"],
      ["lsrc:1", "escalated-human"],
    ]);
    const answered = h.decisions[0];
    expect(answered.sessionId).toBe("session-0");
    expect(answered.reason).toContain("Dangerous rm operation");
    expect(answered.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it("publishes the panes that are blocked right now, with the age their prompt has", async () => {
    const screens = { 1: UNSAFE };
    const h = harness({ screens });
    await h.wd.tick(); h.advance(130_000); await h.wd.tick();
    const open = h.snapshots.at(-1).prompts;
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ pane: "lsrc:1", orchestratorNotified: true, answered: false });
    expect(open[0].decision).toContain("needs-owner");
    expect(Date.parse(open[0].firstSeenAt)).toBe(0);

    screens[1] = IDLE;
    await h.wd.tick();
    expect(h.snapshots.at(-1).prompts).toEqual([]);
  });
});

// 2026-09-29: the bridge's watchdog had published nothing since the bridge restarted on 28 Sep and logged no
// decision since 16 Sep, while lsrc:1 and skydive:0 sat on prompts it should have seen; nothing showed it had stopped.
describe("the watchdog stays alive and says so", () => {
  it("beats after a finished round, at most every 30 s, so amux doctor sees it alive", async () => {
    const h = harness({ screens: {} });
    await h.wd.tick();
    expect(h.beats).toEqual([{ panes: 2, prompts: 0 }]);
    h.advance(10_000); await h.wd.tick();
    expect(h.beats).toHaveLength(1);
    h.advance(20_000); await h.wd.tick();
    expect(h.beats).toHaveLength(2);
  });

  it("reads the other panes and still beats when one pane never answers its capture", async () => {
    const screens = { 1: UNSAFE };
    const h = harness({ screens, capture: (_n, pane) => (pane === 0 ? new Promise(() => {}) : Promise.resolve(screens[pane])) });
    await h.wd.tick(); h.advance(130_000); await h.wd.tick();
    expect(h.decisions.map((d) => [d.pane, d.action])).toEqual([["lsrc:1", "escalated-orchestrator"]]);
    expect(h.beats.at(-1)).toEqual({ panes: 2, prompts: 1 });
  });

  it("starts no round while the last one is still reading", async () => {
    let release;
    const h = harness({ screens: {}, capture: (_n, pane) => (pane === 0 ? new Promise((done) => { release = () => done(IDLE); }) : Promise.resolve(IDLE)) });
    const first = h.wd.tick();
    expect(await h.wd.tick()).toEqual([]);
    expect(h.agent.capturePane).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(h.agent.capturePane).toHaveBeenCalledTimes(2);
  });
});

describe("gitKeepsFilesUnder", () => {
  it("keeps tracked and new files, lets an ignored folder and a path outside git go", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { gitKeepsFilesUnder } = await import("./permission-watchdog.mjs");
    const outside = mkdtempSync(join(tmpdir(), "wd-outside-"));
    const repo = mkdtempSync(join(tmpdir(), "wd-repo-"));
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, ".gitignore"), "scratch/\n");
    mkdirSync(join(repo, "scratch")); writeFileSync(join(repo, "scratch", "a.audio"), "x");
    mkdirSync(join(repo, "notes")); writeFileSync(join(repo, "notes", "2026-09-14.md"), "new, never committed");
    mkdirSync(join(outside, "tmp")); writeFileSync(join(outside, "tmp", "b"), "x");

    expect(gitKeepsFilesUnder(join(repo, "scratch"))).toBe(false);
    expect(gitKeepsFilesUnder(join(repo, "notes"))).toBe(true);
    expect(gitKeepsFilesUnder(join(repo, "notes", "2026-09-1"))).toBe(true);
    expect(gitKeepsFilesUnder(join(outside, "tmp"))).toBe(false);
  });
});
