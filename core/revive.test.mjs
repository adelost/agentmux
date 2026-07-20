import { unit, feature, expect } from "bdd-vitest";
import {
  journalInterruptionFromTurns, codexInterruptionFromTurns, planRevive, reviveBrief, parseBootMs, selectRevivePanes,
} from "./revive.mjs";

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

feature("Codex post-boot interruption detection", () => {
  unit("an incomplete pre-boot turn needs recovery", {
    given: ["ai:3-shaped interrupted rollout", () => [{
      timestamp: "2026-07-10T16:55:00Z",
      userPrompt: "run the full gate",
      isComplete: false,
    }]],
    when: ["deriving interruption", (turns) => codexInterruptionFromTurns(turns, BOOT)],
    then: ["returns the interrupted turn timestamp", (ms) => {
      expect(ms).toBe(Date.parse("2026-07-10T16:55:00Z"));
    }],
  });

  unit("a completed turn or any post-boot turn stays silent", {
    given: ["completed pre-boot plus active post-boot shapes", () => ({
      completed: [{ timestamp: "2026-07-10T16:55:00Z", isComplete: true }],
      resumed: [
        { timestamp: "2026-07-10T16:55:00Z", isComplete: false },
        { timestamp: "2026-07-10T17:01:00Z", isComplete: false },
      ],
    })],
    when: ["deriving both", ({ completed, resumed }) => [
      codexInterruptionFromTurns(completed, BOOT),
      codexInterruptionFromTurns(resumed, BOOT),
    ]],
    then: ["neither is re-briefed", (result) => expect(result).toEqual([null, null])],
  });

  unit("a journal interruption joins the ledger-derived revive plan once", {
    given: ["one Codex-sourced interruption", () => planRevive({
      events: [],
      bootMs: BOOT,
      panes: [{ agent: "ai", pane: 3 }],
      statuses: new Map([["ai:3", "interrupted"]]),
      journalInterruptions: [{
        agent: "ai",
        pane: 3,
        interruptedAtMs: Date.parse("2026-07-10T16:55:00Z"),
        source: "codex-jsonl",
      }],
    })],
    when: ["planning", (plan) => plan],
    then: ["one recovery brief carrying its evidence source", (plan) => {
      expect(plan.briefs).toMatchObject([{
        agent: "ai",
        pane: 3,
        source: "codex-jsonl",
      }]);
    }],
  });

  unit("a Kimi-shaped interrupted turn classifies via the journal reader too", {
    given: ["wire turns: one incomplete pre-boot turn, one complete", () => journalInterruptionFromTurns([
      { timestamp: "2026-07-10T16:50:00Z", isComplete: true },
      { timestamp: "2026-07-10T16:55:00Z", isComplete: false },
    ], BOOT)],
    when: ["reading the interruption", (result) => result],
    then: ["the incomplete pre-boot turn is the interruption", (result) => {
      expect(result).toBe(Date.parse("2026-07-10T16:55:00Z"));
    }],
  });

  unit("a Kimi pane with only a completed turn stays silent", {
    given: ["one complete pre-boot turn", () => journalInterruptionFromTurns([
      { timestamp: "2026-07-10T16:55:00Z", isComplete: true },
    ], BOOT)],
    when: ["reading the interruption", (result) => result],
    then: ["none", (result) => expect(result).toBeNull()],
  });

  unit("selective revive picks exactly the interrupted panes; --all picks the fleet", {
    given: ["two interrupted of five panes", () => {
      const panes = [
        { agent: "skydive", pane: 10 }, { agent: "skydive", pane: 12 },
        { agent: "skyvw", pane: 7 }, { agent: "lsrc", pane: 2 }, { agent: "lsrc", pane: 3 },
      ];
      const briefs = [
        { agent: "skydive", pane: 10, interruptedAtMs: 1 },
        { agent: "lsrc", pane: 2, interruptedAtMs: 2 },
      ];
      return { panes, briefs };
    }],
    when: ["selecting default and --all", ({ panes, briefs }) => ({
      selective: selectRevivePanes(panes, briefs),
      all: selectRevivePanes(panes, briefs, { all: true }),
    })],
    then: ["default revives exactly the two, --all revives all five", ({ selective, all }) => {
      expect(selective.map((p) => `${p.agent}:${p.pane}`).sort()).toEqual(["lsrc:2", "skydive:10"]);
      expect(all).toHaveLength(5);
    }],
  });
});
