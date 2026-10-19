import { feature, unit, expect } from "bdd-vitest";
import { createIdleCapacityAlarm, IDLE_CAPACITY_STATE_KEY } from "./idle-capacity-alarm.mjs";

// The night of 2026-10-18: skyvw:0 stopped at Claude W's weekly limit 17:38Z with the lead
// handoff parked behind it; Claude S had room from 22:34Z; nobody was told until 04:27Z.
const LIMIT_AT = Date.parse("2026-10-18T17:38:13Z");
const nightReceipt = { limitEventId: "limit-1", limitKind: "weekly", observedAt: LIMIT_AT };
const parked = { id: "handoff", status: "pending", createdAt: Date.parse("2026-10-18T22:46:11Z"),
  nextAttemptAt: Number.MAX_SAFE_INTEGER, metadata: { quotaLimitEventId: "limit-1" } };
const claudeS = { name: "Claude S", profileId: "1", usedPercent: 0 };

function night({ room = claudeS, at = "2026-10-18T22:40:00Z" } = {}) {
  const values = {};
  const fx = {
    clock: Date.parse(at),
    panes: {
      "skyvw:0": { limitReceipt: nightReceipt, jobs: [parked], processStopped: false },
      "skyvw:2": { limitReceipt: null, jobs: [], processStopped: true },
      "lsrc:0": { limitReceipt: nightReceipt, jobs: [], processStopped: false },
    },
    notices: [],
    state: { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } },
  };
  fx.alarm = createIdleCapacityAlarm({
    target: "lsrc:0",
    panes: () => Object.keys(fx.panes).map((key) => ({ key, engine: "claude" })),
    observe: async (pane) => fx.panes[pane.key],
    roomFor: async (engine) => (engine === "claude" ? room : null),
    notify: async (text, idempotencyKey) => { fx.notices.push({ text, idempotencyKey }); },
    state: fx.state,
    now: () => fx.clock,
  });
  return fx;
}

feature("the idle-capacity alarm", () => {
  unit("a pane stopped at a spent week is reported once to the dispatcher while another account has room", {
    given: ["the night at 22:40Z, five hours after skyvw:0 stopped", () => night()],
    when: ["the alarm checks twice", async (fx) => {
      await fx.alarm.tick();
      fx.clock += 5 * 60_000;
      await fx.alarm.tick();
      return fx;
    }],
    then: ["one notice names the pane, its stop, the waiting handoff and Claude S", (fx) => {
      expect(fx.notices).toEqual([{
        idempotencyKey: "idle-capacity:skyvw:0:limit:limit-1",
        text: "[idle-capacity] skyvw:0 has not been able to work for 5 h 2 min: stopped at its weekly limit,"
          + " 1 message(s) waiting. Claude S has room (0 % of the week used). Move it with"
          + " `amux accounts rotate claude:1`, or record why it stays. One notice per pane and episode.",
      }]);
    }],
  });

  unit("no account with room, a short stop or a sleeping pane with nothing queued sends nothing", {
    given: ["three quiet cases", () => [night({ room: null }), night({ at: "2026-10-18T17:50:00Z" }), night()]],
    when: ["each alarm checks", async ([spent, early, sleeping]) => {
      delete sleeping.panes["skyvw:0"];
      for (const fx of [spent, early, sleeping]) await fx.alarm.tick();
      return [spent, early, sleeping];
    }],
    then: ["the dispatcher hears nothing", (cases) => {
      expect(cases.map((fx) => fx.notices.length)).toEqual([0, 0, 0]);
    }],
  });

  unit("a pane that recovered and stops again is a new episode", {
    given: ["skyvw:0 reported once", async () => {
      const fx = night();
      await fx.alarm.tick();
      return fx;
    }],
    when: ["it works for a while, then hits a new limit", async (fx) => {
      fx.panes["skyvw:0"] = { limitReceipt: null, jobs: [], processStopped: false };
      await fx.alarm.tick();
      fx.panes["skyvw:0"] = { limitReceipt: { ...nightReceipt, limitEventId: "limit-2", observedAt: fx.clock },
        jobs: [], processStopped: false };
      fx.clock += 20 * 60_000;
      await fx.alarm.tick();
      return fx;
    }],
    then: ["two notices, one per episode, and the state forgets the first", (fx) => {
      expect(fx.notices.map((notice) => notice.idempotencyKey)).toEqual([
        "idle-capacity:skyvw:0:limit:limit-1",
        "idle-capacity:skyvw:0:limit:limit-2",
      ]);
      expect(Object.keys(fx.state.get(IDLE_CAPACITY_STATE_KEY))).toEqual(["skyvw:0"]);
    }],
  });
});
