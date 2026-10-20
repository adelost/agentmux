import { feature, unit, expect } from "bdd-vitest";
import { windDownStage, compactPays, moveTarget, windDownNotice, windDownContinuation } from "./quota-wind-down.mjs";

const at = time => Date.parse(`2026-10-20T${time}Z`);
const session = { kind: "session", usedPercent: 94, resetsAt: "2026-10-20T11:10:00Z" };
const account = (key, week = 40, used = 10, observedAt = "10:10:00") => ({
  ok: true, provider: "claude", name: key, profile: { key, id: key.split(":")[1] },
  observation: { observedAt: new Date(at(observedAt)).toISOString() },
  limits: [{ kind: "weekly_all", usedPercent: week, resetsAt: "2026-10-23T11:10:00Z" },
    { kind: "session", usedPercent: used, resetsAt: session.resetsAt }],
});

feature("quota wind-down decisions (unit)", () => {
  unit("notice at the 5 % point between readings", {
    given: ["94 % at 10:03:32 in the window opened 06:10", () => ({ windows: [session], observedAt: at("10:03:32") })],
    when: ["checking at the reading and at 10:07:10", facts => [at("10:03:32"), at("10:07:10")].map(now => windDownStage({ ...facts, now }))],
    then: ["only the later poll notices, from this window's own pace", ([first, later]) => {
      expect(first).toBeNull();
      expect(later).toMatchObject({ stage: "notice", window: "session", resetAt: at("11:10:00") });
      expect(later.leftPercent).toBeCloseTo(4.53754, 4);
    }],
  });
  unit("nudge at 3 %", {
    when: ["97 % used on a fresh reading", () => windDownStage({ windows: [{ ...session, usedPercent: 97 }], now: at("10:12:00"), observedAt: at("10:12:00") })],
    then: ["the nudge stage", stage => expect(stage.stage).toBe("nudge")],
  });
  unit("the nearer window decides", {
    when: ["a week at 96 % but the session stops sooner at 94 %", () => windDownStage({ windows: [session,
      { kind: "week", usedPercent: 96, resetsAt: "2026-10-23T11:10:00Z" }], now: at("10:03:32"), observedAt: at("10:03:32") })],
    then: ["no notice yet for the nearer session", result => expect(result).toBeNull()],
  });
  unit("stale reading: none", {
    when: ["a 97 % reading over ten minutes old", () => windDownStage({ windows: [{ ...session, usedPercent: 97 }], now: at("10:15:00"), observedAt: at("10:03:32") })],
    then: ["no stage", stage => expect(stage).toBeNull()],
  });
  unit("missing and future readings: none", {
    when: ["no trustworthy observation time", () => [undefined, at("10:16:00")].map(observedAt => windDownStage({ windows: [session], now: at("10:15:00"), observedAt }))],
    then: ["no stage", stages => expect(stages).toEqual([null, null])],
  });
  unit("a short stop with no room gets the notice without a compact", {
    when: ["UC-5 working Claude pane, stop 15:29:37 and reset 16:10", () => compactPays({ engine: "claude", stopAt: at("15:29:37"), resetAt: at("16:10:00"), working: true, target: null })],
    then: ["its warm restart costs less", pays => expect(pays).toBe(false)],
  });
  unit("an idle pane at 10:07 with reset 11:10 pays", {
    when: ["UC-2 idle since 09:59", () => compactPays({ engine: "claude", stopAt: at("10:19:37"), resetAt: at("11:10:00"), lastActivityAt: at("09:59:00"), working: false })],
    then: ["compact before the cold restart", pays => expect(pays).toBe(true)],
  });
  unit("a move pays even across a short stop; Codex uses its own cache life", {
    when: ["a target exists or the stop outlasts Codex's cache", () => [compactPays({ engine: "claude", target: {} }),
      compactPays({ engine: "codex", stopAt: at("15:29:37"), resetAt: at("16:10:00"), working: true })]],
    then: ["both pay", results => expect(results).toEqual([true, true])],
  });
  unit("no move to a target whose session is low", {
    when: ["the largest week has only 19 % session left", () => moveTarget({ engine: "claude", accounts: [account("claude:1", 10, 81), account("claude:2")], from: "claude:3", readAfter: at("10:09:00") })],
    then: ["the next account with room in both windows wins", target => expect(target.name).toBe("claude:2")],
  });
  unit("no move on a reading older than the compact", {
    when: ["room was read before or exactly at compact verification", () => moveTarget({ engine: "claude", accounts: [account("claude:2")], from: "claude:1", readAfter: at("10:10:00") })],
    then: ["no target", target => expect(target).toBeNull()],
  });
  unit("the current account, its aliases and a missing window never qualify", {
    when: ["only the current login and an incomplete reading", () => moveTarget({ engine: "claude", from: "claude:1", readAfter: at("10:09:00"),
      accounts: [{ ...account("claude:2"), sharedBy: [{ key: "claude:1" }] }, { ...account("claude:3"), limits: account("claude:3").limits.slice(0, 1) }] })],
    then: ["no target", target => expect(target).toBeNull()],
  });
  unit("notice and continuation match design §2", {
    when: ["formatting the three strings", () => [windDownNotice({ stage: "notice", account: "Claude S", leftPercent: 5, window: "session", resetAt: at("11:10:00") }),
      windDownNotice({ stage: "nudge", account: "Claude S" }), windDownContinuation({ from: "Claude S", to: "Claude A" })]],
    then: ["the exact contract texts", texts => expect(texts).toEqual([
      "[AMUX QUOTA WIND-DOWN · 5 %] Claude S has 5 % of its session window left (resets 11:10Z). Finish the current step and start no new large one; amux compacts this session when your turn ends.",
      "[AMUX QUOTA WIND-DOWN · 3 %] Claude S is about to stop. End your turn at the next clean boundary; amux compacts this session then.",
      "[AMUX QUOTA WIND-DOWN · MOVED] This session was compacted and moved from Claude S to Claude A, which has room. Continue the task from the compact summary. Do not repeat an external side effect that already has a receipt.",
    ])],
  });
});
