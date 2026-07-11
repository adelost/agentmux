import { unit, feature, expect } from "bdd-vitest";
import { planRevive, reviveBrief, parseBootMs } from "./revive.mjs";

// The real 2026-07-10 18:58 WSL crash, straight from the ledger: three
// panes had a trailing prompt (ai:0 18:36, ai:2 18:40, api:1 18:41), the
// rest ended on stop. ai:2 had self-recovered (working) by revive time.
const BOOT = Date.parse("2026-07-10T16:58:12Z");
const EVENTS = [
  { ts: "2026-07-10T16:36:07Z", event: "prompt", session: "ai", pane: 0 },
  { ts: "2026-07-10T16:40:35Z", event: "prompt", session: "ai", pane: 2 },
  { ts: "2026-07-10T16:41:56Z", event: "prompt", session: "api", pane: 1 },
  { ts: "2026-07-10T16:40:51Z", event: "prompt", session: "claw", pane: 0 },
  { ts: "2026-07-10T16:40:51Z", event: "stop", session: "claw", pane: 0 },
  { ts: "2026-07-10T16:25:57Z", event: "stop", session: "claw", pane: 8 },
];
const PANES = [
  { agent: "ai", pane: 0 }, { agent: "ai", pane: 2 },
  { agent: "api", pane: 1 }, { agent: "claw", pane: 0 }, { agent: "claw", pane: 8 },
];

feature("planRevive — the 2026-07-10 crash as known-answer fixture", () => {
  unit("finds exactly the hand-verified interrupted set, minus self-recovered", {
    given: ["real ledger shape, ai:2 already working again", () => planRevive({
      events: EVENTS, bootMs: BOOT, panes: PANES,
      statuses: new Map([["ai:2", "working"], ["ai:0", "idle"], ["api:1", "idle"]]),
    })],
    when: ["planning", (p) => p],
    then: ["ai:0 and api:1 get briefs; ai:2 (working) and clean panes do not", (p) => {
      const keys = p.briefs.map((b) => `${b.agent}:${b.pane}`).sort();
      expect(keys).toEqual(["ai:0", "api:1"]);
    }],
  });

  unit("post-boot activity suppresses stale crash archaeology", {
    given: ["api:1 completed a turn after restart", () => planRevive({
      events: [
        ...EVENTS,
        { ts: "2026-07-10T17:00:26Z", event: "stop", session: "api", pane: 1 },
      ],
      bootMs: BOOT, panes: [{ agent: "api", pane: 1 }],
      statuses: new Map([["api:1", "idle"]]),
    })],
    when: ["planning", (p) => p],
    then: ["not briefed again", (p) => {
      expect(p.briefs).toEqual([]);
    }],
  });

  unit("the same interrupted turn is briefed at most once per boot", {
    given: ["a successful revive receipt after boot", () => planRevive({
      events: [
        ...EVENTS,
        {
          ts: "2026-07-10T17:08:00Z",
          event: "revive_brief",
          session: "api",
          pane: 1,
          interruptedAtMs: Date.parse("2026-07-10T16:41:56Z"),
        },
      ],
      bootMs: BOOT,
      panes: [{ agent: "api", pane: 1 }],
      statuses: new Map([["api:1", "idle"]]),
    })],
    when: ["planning a second revive", (p) => p],
    then: ["no duplicate brief", (p) => expect(p.briefs).toEqual([])],
  });

  unit("event append order cannot overwrite a newer pre-boot state", {
    given: ["a delayed older prompt appended after a newer stop", () => planRevive({
      events: [
        { ts: "2026-07-10T16:50:00Z", event: "stop", session: "api", pane: 1 },
        { ts: "2026-07-10T16:40:00Z", event: "prompt", session: "api", pane: 1 },
      ],
      bootMs: BOOT,
      panes: [{ agent: "api", pane: 1 }],
      statuses: new Map([["api:1", "idle"]]),
    })],
    when: ["planning", (p) => p],
    then: ["the timestamp-newer stop wins", (p) => expect(p.briefs).toEqual([])],
  });

  unit("panes that finished cleanly pre-boot stay silent", {
    given: ["only stop-terminated panes", () => planRevive({
      events: EVENTS, bootMs: BOOT,
      panes: [{ agent: "claw", pane: 0 }, { agent: "claw", pane: 8 }],
      statuses: new Map(),
    })],
    when: ["planning", (p) => p],
    then: ["no briefs", (p) => { expect(p.briefs).toEqual([]); }],
  });

  unit("missing boot time degrades to no-op with a reason (fail visible)", {
    given: ["bootMs null", () => planRevive({ events: EVENTS, bootMs: null, panes: PANES })],
    when: ["planning", (p) => p],
    then: ["no briefs + reason", (p) => {
      expect(p.briefs).toEqual([]);
      expect(p.reason).toContain("boot");
    }],
  });
});

feature("boot time + brief text", () => {
  unit("btime parses from /proc/stat shape", {
    given: ["a stat excerpt", () => "cpu 1 2 3\nbtime 1783702756\nprocesses 999"],
    when: ["parsing", (s) => parseBootMs(s)],
    then: ["epoch ms", (ms) => { expect(ms).toBe(1783702756000); }],
  });

  unit("brief names both instants and demands re-anchoring", {
    given: ["an interruption", () => reviveBrief(BOOT - 20 * 60_000, BOOT)],
    when: ["rendering", (b) => b],
    then: ["krasch-recovery + amux done + återuppta", (b) => {
      expect(b).toContain("[krasch-recovery]");
      expect(b).toContain("amux done");
      expect(b).toContain("återuppta");
    }],
  });
});
