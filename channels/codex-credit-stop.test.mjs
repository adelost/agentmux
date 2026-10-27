import { afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature, unit } from "bdd-vitest";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createSpentWindows } from "../core/codex-spent-windows.mjs";
import { createCodexCreditStop } from "./codex-credit-stop.mjs";

// claw:5, 27 Oct 2026: Codex A's 5 h window read 100 % from 07:56:59Z and a turn already running went on for 61 model calls
// and 88.723 credits, until an operator pressed Esc at 09:01:45Z. Nothing in amux looked at a running turn.
const NOW = Date.parse("2026-10-27T08:00:30Z");
const RESETS = Math.floor(Date.parse("2026-10-27T12:30:00Z") / 1000);
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

const started = (turnId = "turn-1") => ({ type: "event_msg", payload: { type: "task_started", turn_id: turnId } });
const call = id => ({ type: "response_item", payload: { type: "custom_tool_call", call_id: id } });
const output = id => ({ type: "response_item", payload: { type: "custom_tool_call_output", call_id: id } });
const spent = (balance = "55792.99") => ({ type: "event_msg", payload: { type: "token_count", rate_limits: {
  primary: { used_percent: 100, window_minutes: 300, resets_at: RESETS }, secondary: { used_percent: 72, window_minutes: 10_080, resets_at: RESETS + 5 * 86_400 },
  credits: { has_credits: true, unlimited: false, balance } } } });

function fixture({ events = [started(), call("a"), output("a"), spent()], busy = true, creditsAllowed = false, spare = null,
  screen = "› ", mode = "on" } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "codex-credit-stop-")); roots.push(rootDir);
  const queue = createDeliveryQueue({ rootDir });
  const state = { events, busy, screen, at: NOW }, interrupts = [], moves = [], lines = [], spentWindows = createSpentWindows();
  const stop = createCodexCreditStop({
    panes: () => [{ name: "claw", pane: 5, dir: "/pane" }],
    agent: { isBusy: async () => state.busy, captureScreen: async () => state.screen },
    readEvents: () => state.events,
    interrupt: async (name, pane) => { interrupts.push(`${name}:${pane}`); },
    spare: async () => spare,
    requestMove: async request => { moves.push(request); return { status: "pending" }; },
    accountKeyFor: () => "codex:1", spentWindows,
    queue, creditsAllowed, mode, now: () => state.at, record: line => lines.push(line), log: () => {},
  });
  return { stop, queue, state, interrupts, moves, lines, spentWindows, tick: () => stop.tick() };
}

feature("a Codex turn never goes on drawing paid credits once its account's window is spent", () => {
  component("a running turn is interrupted at the first call after the window read 100 %", {
    given: ["claw:5 working, its last model call read primary 100 % with credits flowing and no tool open", () => fixture()],
    when: ["the guard ticks", async fx => { await fx.tick(); return fx; }],
    then: ["Esc went to claw:5 once and the line names the window, the reset and the balance", fx => {
      expect(fx.interrupts).toEqual(["claw:5"]);
      expect(fx.lines).toEqual([expect.objectContaining({ cell: "codex-credit-stop", pane: "claw:5", outcome: "interrupted",
        window: "session", resetsAt: new Date(RESETS * 1000).toISOString(), balance: 55792.99 })]);
      expect(fx.spentWindows.forPane("claw:5")).toEqual([{ accountKey: "codex:1", window: "session", resetsAt: RESETS * 1000 }]);
    }],
  });
  component("it waits for an open tool call and interrupts right after its output", {
    given: ["claw:5 with a tool call still running after the 100 % reading", () =>
      fixture({ events: [started(), spent(), call("slow")] })],
    when: ["the guard ticks, the tool answers, the guard ticks again", async fx => {
      await fx.tick();
      const waited = fx.interrupts.length;
      fx.state.events = [started(), spent(), call("slow"), output("slow")];
      await fx.tick();
      return { fx, waited };
    }],
    then: ["no Esc while the tool ran, one Esc after its output", ({ fx, waited }) => {
      expect(waited).toBe(0);
      expect(fx.interrupts).toEqual(["claw:5"]);
      expect(fx.lines.map(line => line.outcome)).toEqual(["waits-for-tool", "interrupted"]);
    }],
  });
  component("a still-busy pane is not interrupted twice within a stop, but a stuck Esc is retried after 15 s", {
    given: ["claw:5 that stays busy after the first Esc", () => fixture()],
    when: ["ticks at +0 s, +5 s and +20 s", async fx => {
      await fx.tick(); fx.state.at += 5_000; await fx.tick(); fx.state.at += 15_000; await fx.tick();
      return fx;
    }],
    then: ["two Esc, not three", fx => { expect(fx.interrupts).toEqual(["claw:5", "claw:5"]); }],
  });
  unit("an idle pane draws no credits and is left alone", {
    given: ["claw:5 idle on a spent account", () => fixture({ busy: false })],
    when: ["the guard ticks", async fx => { await fx.tick(); return fx; }],
    then: ["no Esc", fx => { expect(fx.interrupts).toEqual([]); expect(fx.lines).toEqual([]); }],
  });
  component("in dry mode the guard says what it would do and does nothing", {
    given: ["claw:5 on a spent window, a spare account, AMUX_CODEX_CREDIT_STOP=dry", () => fixture({ mode: "dry", spare: { profileId: "2", name: "Codex W" } })],
    when: ["the guard ticks twice", async fx => { await fx.tick(); await fx.tick(); return fx; }],
    then: ["one would-interrupt line, no Esc, no move, no job, nothing stored for the floor", fx => {
      expect(fx.lines.map(line => line.outcome)).toEqual(["would-interrupt"]);
      expect(fx.interrupts).toEqual([]); expect(fx.moves).toEqual([]); expect(fx.queue.list("claw", 5)).toEqual([]);
      expect(fx.spentWindows.forPane("claw:5")).toEqual([]);
    }],
  });
  unit("with the guard off nothing is read", {
    given: ["AMUX_CODEX_CREDIT_STOP=off", () => fixture({ mode: "off" })],
    when: ["the guard ticks", async fx => { await fx.tick(); return fx; }],
    then: ["no line, no Esc", fx => { expect(fx.lines).toEqual([]); expect(fx.interrupts).toEqual([]); }],
  });
  unit("credits the operator allowed explicitly are left alone", {
    given: ["AMUX_CODEX_CREDITS=allow", () => fixture({ creditsAllowed: true })],
    when: ["the guard ticks", async fx => { await fx.tick(); return fx; }],
    then: ["no Esc", fx => { expect(fx.interrupts).toEqual([]); }],
  });
  unit("a permission prompt is not answered with Esc", {
    given: ["claw:5 waiting on an approval", () => fixture({ screen: "Allow command?  1. Yes, proceed\n 2. No, and tell Codex what to do differently (esc)" })],
    when: ["the guard ticks", async fx => { await fx.tick(); return fx; }],
    then: ["no Esc", fx => { expect(fx.interrupts).toEqual([]); }],
  });
  unit("a new turn on the same pane is a new stop", {
    given: ["claw:5 interrupted in turn-1, then working in turn-2 with a spent reading", () => fixture()],
    when: ["the guard ticks, the pane starts turn-2 and ticks again", async fx => {
      await fx.tick();
      fx.state.events = [started("turn-2"), spent("55700.00")]; fx.state.at += 60_000;
      await fx.tick();
      return fx;
    }],
    then: ["two Esc", fx => { expect(fx.interrupts).toEqual(["claw:5", "claw:5"]); }],
  });
});

feature("the interrupted work continues instead of being lost", () => {
  component("with another account that has room, the pane is moved there and the move carries the continuation", {
    given: ["a spare Codex account", () => fixture({ spare: { profileId: "2", name: "Codex W" } })],
    when: ["the guard ticks", async fx => { await fx.tick(); return fx; }],
    then: ["one move request to account 2 whose text says what happened, and nothing queued on the spent account", fx => {
      expect(fx.moves).toEqual([expect.objectContaining({ name: "claw", pane: 5, profileId: "2",
        continuation: expect.stringContaining("paid credits are not allowed") })]);
      expect(fx.queue.list("claw", 5)).toEqual([]);
    }],
  });
  component("with no account that has room, one continuation waits in the real queue, held by the floor like any automatic work", {
    given: ["no spare account", () => fixture({ spare: null })],
    when: ["the guard ticks twice for the same stop", async fx => { await fx.tick(); await fx.tick(); return fx; }],
    then: ["a single job from the guard and no move", fx => {
      const jobs = fx.queue.list("claw", 5);
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ source: "codex-credit-stop", status: "pending" });
      expect(jobs[0].text).toContain("Do not repeat an external side effect that already has a receipt");
      expect(fx.moves).toEqual([]);
    }],
  });
  component("an idle pane whose message the credit hold keeps back is moved to an account with room", {
    given: ["claw:5 idle with a prompt held by the spent 5 h window, and a spare account", () => {
      const fx = fixture({ busy: false, spare: { profileId: "2", name: "Codex W" } });
      const held = fx.queue.enqueue({ agentName: "claw", pane: 5, text: "Hur går det?", source: "discord", idempotencyKey: "owner-1" });
      fx.queue.update(held, { costHold: true, lastReason: "wake-refused:quota-floor: Codex A has spent its 5h window until 2026-10-27T12:30:00.000Z; a turn now draws paid credits" });
      return fx;
    }],
    when: ["the guard ticks twice", async fx => { await fx.tick(); await fx.tick(); return fx; }],
    then: ["one move request with no continuation, since the held message lands after the move", fx => {
      expect(fx.moves).toEqual([expect.objectContaining({ name: "claw", pane: 5, profileId: "2", continuation: null })]);
      expect(fx.interrupts).toEqual([]);
    }],
  });
  unit("a message held for another reason does not move the pane", {
    given: ["claw:5 idle with a prompt held by the weekly floor of a Claude account, and a spare account", () => {
      const fx = fixture({ busy: false, spare: { profileId: "2", name: "Codex W" } });
      const held = fx.queue.enqueue({ agentName: "claw", pane: 5, text: "brief", source: "cli", idempotencyKey: "brief-1" });
      fx.queue.update(held, { costHold: true, lastReason: "wake-refused:quota-floor: Claude S has 3 % of its week left (floor 3 %) until 2026-10-28T04:00:00Z" });
      return fx;
    }],
    when: ["the guard ticks", async fx => { await fx.tick(); return fx; }],
    then: ["no move", fx => { expect(fx.moves).toEqual([]); }],
  });
});
