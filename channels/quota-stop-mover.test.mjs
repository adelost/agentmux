import { component, expect, feature, unit } from "bdd-vitest";
import { createQuotaStopMover, quotaStopMoves } from "./quota-stop-mover.mjs";

// lsrc:0 for Mattias 2026-10-21 (day file 04:14Z): Claude S reached its weekly floor at 23:39Z and its 21 panes were
// parked; Claude A renewed at 00:00Z, yet nothing moved them before 03:52Z.
const claudeS = (usedPercent, fetchedAt) => ({ ok: true, provider: "claude", name: "Claude S", fetchedAt,
  profile: { key: "claude:1", id: "1" }, account: { email: "s@example.com" }, inUse: ["claw:2", "lsrc:0"],
  limits: [{ kind: "session", usedPercent: 2, resetsAt: "2026-10-21T02:10:00Z" },
    { kind: "weekly_all", usedPercent, resetsAt: "2026-10-27T03:59:59.963Z" }] });
// Claude names no reset for a window unused since it reset (Claude S at 16:10:01Z on 2026-10-20).
const claudeA = (usedPercent, fetchedAt, weekResetsAt) => ({ ok: true, provider: "claude", name: "Claude A", fetchedAt,
  profile: { key: "claude:2", id: "2" }, account: { email: "a@example.com" }, inUse: [],
  limits: [{ kind: "session", usedPercent: 0, resetsAt: null }, { kind: "weekly_all", usedPercent, resetsAt: weekResetsAt }] });

// Case 11, lsrc:0 2026-10-21 07:0xZ: Claude A's session read 75 % at 07:00Z with 21 panes and resets at 08:50Z, so it runs
// out first, while Claude W's week renewed at 07:00Z.
const claudeASession = (usedPercent, fetchedAt) => ({ ...claudeA(20, fetchedAt, "2026-10-28T00:00:00Z"), inUse: ["claw:2", "lsrc:0"],
  limits: [{ kind: "session", usedPercent, resetsAt: "2026-10-21T08:50:00Z" },
    { kind: "weekly_all", usedPercent: 20, resetsAt: "2026-10-28T00:00:00Z" }] });
const claudeW = (sessionPercent, fetchedAt) => ({ ok: true, provider: "claude", name: "Claude W", fetchedAt,
  profile: { key: "claude:3", id: "3" }, account: { email: "w@example.com" }, inUse: [],
  limits: [{ kind: "session", usedPercent: sessionPercent, resetsAt: sessionPercent ? "2026-10-21T11:00:00Z" : null },
    { kind: "weekly_all", usedPercent: 0, resetsAt: "2026-10-28T07:00:00Z" }] });

const mover = (accounts, at) => {
  const rotations = [], lines = [];
  const stopMover = createQuotaStopMover({ runtime: () => ({ deliveryQueue: {} }), readSnapshot: async () => ({ accounts }),
    rotate: async (_ctx, target, options) => { rotations.push({ target, ...options }); return { status: "RECOVERED", rows: [] }; },
    floorPercent: 3, now: () => Date.parse(at), record: line => lines.push(line) });
  return { rotations, lines, tick: () => stopMover.tick() };
};

feature("an account's stop moves its panes to an account with room", () => {
  // Case 1, from the moment the other account has verified room.
  component("Claude S's panes move to Claude A at the first reading that shows Claude A renewed", {
    given: ["Claude S at 97 % of its week, Claude A read at 0 % at 00:00:05Z after its renewal", () =>
      mover([claudeS(97, "2026-10-21T00:00:10Z"), claudeA(0, "2026-10-21T00:00:05Z", "2026-10-28T00:00:00Z")], "2026-10-21T00:00:30Z")],
    when: ["the mover ticks", ctx => ctx.tick()],
    then: ["a rotation of exactly Claude S's panes to Claude A, logged", (_result, ctx) => {
      expect(ctx.rotations).toEqual([{ target: "2", only: ["claw:2", "lsrc:0"] }]);
      expect(ctx.lines).toEqual([expect.objectContaining({ cell: "quota-stop-move", from: "Claude S", to: "Claude A", outcome: "RECOVERED" })]);
    }],
  });
  // Case 7: 23:39Z to 00:00Z Claude A read 97 % too, so the panes stay parked, silently.
  component("with no other account's room verified, nothing moves", {
    given: ["Claude S and Claude A both at 97 % at 23:52Z", () =>
      mover([claudeS(97, "2026-10-20T23:52:10Z"), claudeA(97, "2026-10-20T23:52:05Z", "2026-10-21T00:00:00Z")], "2026-10-20T23:52:30Z")],
    when: ["the mover ticks", ctx => ctx.tick()],
    then: ["no rotation", (_result, ctx) => { expect(ctx.rotations).toEqual([]); }],
  });
  unit("a reading of the other account older than ten minutes is not verified room", {
    given: ["Claude A read at 0 % fifteen minutes ago", () => ({
      accounts: [claudeS(97, "2026-10-21T00:15:10Z"), claudeA(0, "2026-10-21T00:00:05Z", "2026-10-28T00:00:00Z")],
      now: Date.parse("2026-10-21T00:15:30Z") })],
    when: ["deciding the moves", ({ accounts, now }) => quotaStopMoves({ accounts, floorPercent: 3, now })],
    then: ["none", moves => expect(moves).toEqual([])],
  });
});

feature("a session about to run out moves its panes when its reset lies beyond the cache's life", () => {
  // At its pace since 03:50Z, 92 % at 07:36Z runs out at about 07:56Z, 54 minutes before the reset.
  component("Claude A's panes move to Claude W while Claude A's session would stop them until 08:50Z", {
    given: ["Claude A's session at 92 % at 07:36Z, Claude W unused and read at 07:35:30Z", () =>
      mover([claudeASession(92, "2026-10-21T07:35:40Z"), claudeW(0, "2026-10-21T07:35:30Z")], "2026-10-21T07:36:00Z")],
    when: ["the mover ticks", ctx => ctx.tick()],
    then: ["a rotation of exactly Claude A's panes to Claude W, logged with the session as the cause", (_result, ctx) => {
      expect(ctx.rotations).toEqual([{ target: "3", only: ["claw:2", "lsrc:0"] }]);
      expect(ctx.lines).toEqual([expect.objectContaining({ cell: "quota-stop-move", from: "Claude A", to: "Claude W", window: "session" })]);
    }],
  });
  unit("a session at its limit that resets within the cache's life keeps its panes waiting", {
    given: ["Claude A's session at 97 % at 08:10Z, 40 minutes before its reset", () => ({
      accounts: [claudeASession(97, "2026-10-21T08:09:40Z"), claudeW(0, "2026-10-21T08:09:30Z")], now: Date.parse("2026-10-21T08:10:00Z") })],
    when: ["deciding the moves", ({ accounts, now }) => quotaStopMoves({ accounts, floorPercent: 3, now })],
    then: ["none", moves => expect(moves).toEqual([])],
  });
  unit("an account without room in its session is no target", {
    given: ["Claude A's session at 92 % at 07:36Z, Claude W's session at 85 %", () => ({
      accounts: [claudeASession(92, "2026-10-21T07:35:40Z"), claudeW(85, "2026-10-21T07:35:30Z")], now: Date.parse("2026-10-21T07:36:00Z") })],
    when: ["deciding the moves", ({ accounts, now }) => quotaStopMoves({ accounts, floorPercent: 3, now })],
    then: ["none", moves => expect(moves).toEqual([])],
  });
});
