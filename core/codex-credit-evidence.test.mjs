import { component, expect, feature, unit } from "bdd-vitest";
import { codexCreditEvidence, codexLastBalance } from "./codex-credit-evidence.mjs";

// claw:5's turn of 27 Oct 2026: Codex A's 5 h window read 100 % from the model call at 07:56:59Z and the turn went on for
// 61 calls and 88.723 credits until an operator pressed Esc at 09:01:45Z. These are the journal's own line shapes.
const NOW = Date.parse("2026-10-27T08:30:00Z");
const RESETS_5H = Math.floor(Date.parse("2026-10-27T12:30:00Z") / 1000);
const RESETS_WEEK = Math.floor(Date.parse("2026-11-02T10:00:00Z") / 1000);

const started = (turnId = "turn-1", timestamp) => ({ type: "event_msg", ...(timestamp ? { timestamp } : {}), payload: { type: "task_started", turn_id: turnId } });
const prompt = message => ({ type: "event_msg", payload: { type: "user_message", message } });
const call = (id, type = "custom_tool_call") => ({ type: "response_item", payload: { type, call_id: id, name: "exec" } });
const output = (id, type = "custom_tool_call_output") => ({ type: "response_item", payload: { type, call_id: id } });
const count = ({ primary = 100, secondary = 72, credits = true, resets = RESETS_5H, balance = "55788.78" } = {}) => ({
  type: "event_msg",
  payload: { type: "token_count", rate_limits: { limit_id: "codex",
    primary: { used_percent: primary, window_minutes: 300, resets_at: resets },
    secondary: { used_percent: secondary, window_minutes: 10_080, resets_at: RESETS_WEEK },
    credits: { has_credits: credits, unlimited: false, balance }, rate_limit_reached_type: null } },
});

feature("a Codex turn's own journal shows a spent window while paid credits flow", () => {
  component("the call after the 5 h window read 100 % is evidence, with its reset and balance", {
    given: ["a turn whose last model call read primary 100 % with credits", () => [started(), call("a"), output("a"), count()]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["the session window, its reset, the balance and no open tool", evidence => {
      expect(evidence).toEqual({ window: "session", resetsAt: RESETS_5H * 1000, balance: 55788.78, balanceAtFirstSpent: 55788.78,
        turnId: "turn-1", startedAt: null, prompts: [], toolOpen: false });
    }],
  });
  unit("a spent week is evidence of the week", {
    given: ["secondary 100 % and primary 40 %", () => [started(), count({ primary: 40, secondary: 100 })]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["the week window", evidence => expect(evidence).toMatchObject({ window: "week", resetsAt: RESETS_WEEK * 1000 })],
  });
  unit("a reading below 100 % is no evidence", {
    given: ["primary 99 %", () => [started(), count({ primary: 99 })]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["none", evidence => expect(evidence).toBeNull()],
  });
  unit("an account without credits refuses by itself, so it is no evidence", {
    given: ["primary 100 % with has_credits false", () => [started(), count({ credits: false })]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["none", evidence => expect(evidence).toBeNull()],
  });
  unit("a window whose reset has passed is no evidence", {
    given: ["primary 100 % that reset at 08:00Z", () => [started(), count({ resets: Math.floor(Date.parse("2026-10-27T08:00:00Z") / 1000) })]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["none", evidence => expect(evidence).toBeNull()],
  });
  component("a new turn is not judged by the previous turn's reading, which may be another account's", {
    given: ["a spent reading, then a new task_started with no model call yet", () => [started("turn-1"), count(), started("turn-2")]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["none", evidence => expect(evidence).toBeNull()],
  });
  unit("only the latest reading counts, so a moved pane's room clears it", {
    given: ["a spent reading followed by a reading of 20 % on the new account", () => [started(), count(), count({ primary: 20 })]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["none", evidence => expect(evidence).toBeNull()],
  });
  component("a tool call without its output is open, whatever its kind", {
    given: ["a function call and a custom tool call, only the second answered", () =>
      [started(), call("f", "function_call"), call("c"), output("c"), count()]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["a tool is open", evidence => expect(evidence.toolOpen).toBe(true)],
  });
  unit("a tail without a turn start reads the whole tail as the running turn", {
    given: ["a long turn whose start left the tail window", () => [call("a"), output("a"), count()]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["the window, with no turn id, no start and no prompts to judge who began it", evidence =>
      expect(evidence).toMatchObject({ window: "session", turnId: null, startedAt: null, prompts: null })],
  });
  component("the evidence carries every prompt of the turn and when it started, so the guard can tell whose turn it is", {
    given: ["a turn begun by an agent's brief and steered by a plain message", () => [started("turn-7", "2026-10-27T07:34:00.000Z"),
      prompt("[from claw:0] Build the Kit view."), call("a"), output("a"), prompt("Hur går det med Kit?"), count()]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["both prompts in order and the start time", evidence => {
      expect(evidence.prompts).toEqual(["[from claw:0] Build the Kit view.", "Hur går det med Kit?"]);
      expect(evidence.startedAt).toBe(Date.parse("2026-10-27T07:34:00.000Z"));
    }],
  });
  component("the balance before is the first call that read the window spent, not the latest", {
    given: ["three calls: the first reading 100 % at 55792.99, then two more drawing credits", () =>
      [started(), count({ balance: "55792.99" }), count({ balance: "55788.78" }), count({ balance: "55780.00" })]],
    when: ["reading the evidence", events => codexCreditEvidence(events, { now: NOW })],
    then: ["before 55792.99, now 55780", evidence => expect(evidence).toMatchObject({ balanceAtFirstSpent: 55792.99, balance: 55780 })],
  });
  unit("the last balance of a journal is read from its latest model call", {
    given: ["a journal ending on a call that read 55704.27", () => [started(), count({ balance: "55792.99" }), count({ balance: "55704.27", primary: 20 })]],
    when: ["reading the last balance", events => codexLastBalance(events)],
    then: ["55704.27", balance => expect(balance).toBe(55704.27)],
  });
});
