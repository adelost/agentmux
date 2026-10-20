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

// lsrc:0 2026-10-19: after the Claude S free reset the notice told the dispatcher to rotate claw:2 to Claude S,
// the account it already ran on, and a pane the quota park stopped (no receipt, empty queue) was never reported.
const CLAUDE_S = { name: "Claude S", profileId: "1", usedPercent: 0, profileKeys: ["claude:1", "claude:login:2"] };
const CLAUDE_A = { name: "Claude A", profileId: "2", usedPercent: 40, profileKeys: ["claude:2"] };

function evening(observation, room, at = "2026-10-19T20:45:00Z") {
  const fx = { clock: Date.parse(at), notices: [], values: {} };
  fx.alarm = createIdleCapacityAlarm({
    target: "lsrc:0",
    panes: () => [{ key: "claw:2", engine: "claude" }],
    observe: async () => observation,
    roomFor: async () => room,
    notify: async (text) => { fx.notices.push(text); },
    state: { get: (key, fallback) => fx.values[key] ?? fallback, set: (key, value) => { fx.values[key] = value; } },
    now: () => fx.clock,
  });
  return fx;
}

feature("the idle-capacity notice and the account a pane is on", () => {
  unit("room on the pane's own account never suggests a rotate; the notice names what amux did", {
    given: ["claw:2 stopped on Claude S since 18:20Z, its recovery prompt cancelled, and Claude S has room", () => evening({
      limitReceipt: { limitEventId: "limit-claw-2", limitKind: "weekly", observedAt: Date.parse("2026-10-19T18:20:39Z") },
      jobs: [], processStopped: false, profileKey: "claude:1",
      resume: "amux's recovery prompt is cancelled: not sent: cancellation requested by claw:0 before submit.",
    }, CLAUDE_S)],
    when: ["the alarm checks", async (fx) => { await fx.alarm.tick(); return fx; }],
    then: ["no rotate command, and the cancelled recovery is named", (fx) => {
      expect(fx.notices).toEqual(["[idle-capacity] claw:2 has not been able to work for 2 h 24 min: stopped at its weekly limit. "
        + "Claude S, the account it is on, has room (0 % of the week used), so a rotate would change nothing. "
        + "amux's recovery prompt is cancelled: not sent: cancellation requested by claw:0 before submit. "
        + "One notice per pane and episode."]);
    }],
  });

  unit("a pane the quota park stopped is reported once it has been idle 15 minutes", {
    given: ["claw:2 got its park notice at 20:10Z with nothing queued, and Claude A has room", () => evening({
      limitReceipt: null, jobs: [], processStopped: false, profileKey: "claude:1",
      park: { state: "parked", parkedAt: "2026-10-19T20:10:00.000Z", window: "week", noticeJobId: "notice-1" },
      resume: "amux has not resumed it yet.",
    }, CLAUDE_A, "2026-10-19T20:26:00Z")],
    when: ["the alarm checks", async (fx) => { await fx.alarm.tick(); return fx; }],
    then: ["the dispatcher hears of the park and where the room is", (fx) => {
      expect(fx.notices).toEqual(["[idle-capacity] claw:2 has not been able to work for 16 min: "
        + "parked by the quota park until its week window has room. Claude A has room (40 % of the week used). "
        + "Move it with `amux accounts rotate claude:2`, or record why it stays. One notice per pane and episode."]);
    }],
  });
});

// lsrc:0 2026-10-20 11:15Z: claw:1, lsrc:1 and lsrc:2 were reported as unable to work for 21 to 52 minutes while amux ps
// showed all three working (claw:1 thinking for 2m51s). At 11:16Z the notices for skyvw:1 and skyvw:2 named recovery
// receipts from 19 Oct while skyvw:1 was posting: resumeStatus took the newest recovery job of any episode.
const STOP_AT = Date.parse("2026-10-20T09:30:00Z");
const weeklyStop = { limitEventId: "limit-w", limitKind: "weekly", observedAt: STOP_AT };
const recoveryJob = (createdAt, status = "acknowledged") => ({ id: `recovery-${createdAt}`, source: "quota-recovery", status,
  createdAt: Date.parse(createdAt), acknowledgedAt: Date.parse(createdAt) + 60_000, lastReason: null });

feature("the idle-capacity alarm and the state of a pane now", () => {
  unit("sends no idle notice about a working pane", {
    given: ["claw:2 with a weekly-limit receipt from 09:30Z, thinking at 11:15Z", () => {
      const observation = { limitReceipt: weeklyStop, jobs: [], processStopped: false, profileKey: "claude:9", paneStatus: "working" };
      return { observation, fx: evening(observation, CLAUDE_S, "2026-10-20T11:15:00Z") };
    }],
    when: ["the alarm checks while it works, then once it is idle", async ({ observation, fx }) => {
      await fx.alarm.tick();
      const whileWorking = [...fx.notices];
      observation.paneStatus = "idle";
      fx.clock += 5 * 60_000;
      await fx.alarm.tick();
      return { whileWorking, afterIdle: fx.notices };
    }],
    then: ["nothing was said about it while it worked, and one notice follows when it stopped", ({ whileWorking, afterIdle }) => {
      expect(whileWorking).toEqual([]);
      expect(afterIdle).toHaveLength(1);
      expect(afterIdle[0]).toContain("[idle-capacity] claw:2 has not been able to work for 1 h 50 min");
    }],
  });

  unit("closes the episode when the recovery prompt is acknowledged", {
    given: ["claw:2 stopped at 09:30Z, its recovery prompt created 10:05Z and acknowledged, and the receipt still open at 11:15Z", () => {
      const observation = { limitReceipt: weeklyStop, jobs: [], processStopped: false, profileKey: "claude:9", paneStatus: "idle",
        history: [recoveryJob("2026-10-20T10:05:00Z")] };
      return { observation, fx: evening(observation, CLAUDE_S, "2026-10-20T11:15:00Z") };
    }],
    when: ["the alarm checks, then again after the queue has forgotten the prompt", async ({ observation, fx }) => {
      await fx.alarm.tick();
      const first = [...fx.notices];
      observation.history = [];
      fx.clock += 5 * 60_000;
      await fx.alarm.tick();
      return { first, second: fx.notices };
    }],
    then: ["it never reports the episode, even after the evidence of the prompt is gone", ({ first, second }) => {
      expect(first).toEqual([]);
      expect(second).toEqual([]);
    }],
  });

  unit("reports only this episode's recovery", {
    given: ["claw:2 stopped at 09:30Z whose only recovery prompt is from 19 Oct, and the same stop with a prompt from 09:40Z that is still pending", () => ({
      old: { limitReceipt: weeklyStop, jobs: [], processStopped: false, profileKey: "claude:1", paneStatus: "idle",
        history: [recoveryJob("2026-10-19T18:24:00Z")] },
      pending: { limitReceipt: weeklyStop, jobs: [], processStopped: false, profileKey: "claude:1", paneStatus: "idle",
        history: [recoveryJob("2026-10-19T18:24:00Z"), recoveryJob("2026-10-20T09:40:00Z", "pending")] },
    })],
    when: ["the alarm reports each", async ({ old, pending }) => {
      const oldRun = evening(old, CLAUDE_S, "2026-10-20T11:15:00Z");
      const pendingRun = evening(pending, CLAUDE_S, "2026-10-20T11:15:00Z");
      await oldRun.alarm.tick();
      await pendingRun.alarm.tick();
      return { oldText: oldRun.notices[0], pendingText: pendingRun.notices[0] };
    }],
    then: ["the 19 Oct prompt is not claimed for this stop, and the prompt of this stop is", ({ oldText, pendingText }) => {
      expect(oldText).toContain("amux has no resume for this stop yet.");
      expect(oldText).not.toContain("2026-10-19");
      expect(pendingText).toContain("amux's recovery prompt is pending");
    }],
  });
});
