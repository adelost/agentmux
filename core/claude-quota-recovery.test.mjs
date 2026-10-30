import { feature, unit, expect } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeClaudeLimitReceipt,
  activeClaudeLimitReceiptFromEvents,
  claudeQuotaRecoveryReadiness,
  parseClaudeLimitResetAt,
  quotaRecoveryJobKey,
  spareClaudeAccount,
} from "./claude-quota-recovery.mjs";
import { claudeProjectDir } from "./claude-paths.mjs";
import { idlePaneEvidence } from "./idle-capacity-alarm.mjs";

const limitEvent = ({
  uuid = "11111111-1111-4111-8111-111111111111",
  timestamp = "2026-07-16T17:01:11.018Z",
  text = "You've hit your session limit · resets 8:50pm (Europe/Stockholm)",
} = {}) => ({
  type: "assistant",
  uuid,
  timestamp,
  message: { stop_reason: "stop_sequence", content: [{ type: "text", text }] },
});

feature("Claude quota-limit receipts", () => {
  unit("an exact terminal response is bound to its persisted session", {
    given: ["a mid-turn limit followed only by bookkeeping", () => [
      { type: "user", uuid: "prompt", message: { content: "ship it" } },
      limitEvent(),
      { type: "system", uuid: "system-after" },
    ]],
    when: ["extracting the receipt", (events) => activeClaudeLimitReceiptFromEvents(events, {
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionPath: "/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    })],
    then: ["event, session, and Stockholm reset survive", (receipt) => {
      expect(receipt).toMatchObject({
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        limitEventId: "11111111-1111-4111-8111-111111111111",
        limitKind: "session",
        resetAt: Date.parse("2026-07-16T18:50:00.000Z"),
      });
    }],
  });

  unit("a later human continuation supersedes automatic recovery", {
    given: ["a real user turn after the limit", () => [
      limitEvent(),
      { type: "user", uuid: "manual", message: { content: "continue" } },
    ]],
    when: ["checking the receipt", (events) => activeClaudeLimitReceiptFromEvents(events, {
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    })],
    then: ["no stale restart authority remains", (receipt) => expect(receipt).toBeNull()],
  });

  unit("the production filesystem reader returns the exact JSONL identity", {
    given: ["an isolated Claude project", () => {
      const homeDir = mkdtempSync(join(tmpdir(), "amux-quota-receipt-"));
      const paneDir = join(homeDir, "repo", ".agents", "2");
      const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const projectDir = claudeProjectDir(paneDir, homeDir);
      const sessionPath = join(projectDir, `${sessionId}.jsonl`);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(sessionPath, `${JSON.stringify(limitEvent())}\n`);
      return { homeDir, paneDir, sessionId, sessionPath };
    }],
    when: ["reading through the bounded-tail seam", (ctx) => ({
      ...ctx,
      receipt: activeClaudeLimitReceipt(ctx.paneDir, { homeDir: ctx.homeDir }),
    })],
    then: ["the path and event are exact", (ctx) => {
      expect(ctx.receipt).toMatchObject({
        sessionId: ctx.sessionId,
        sessionPath: ctx.sessionPath,
        limitEventId: "11111111-1111-4111-8111-111111111111",
      });
      rmSync(ctx.homeDir, { recursive: true, force: true });
    }],
  });

  // defect: every quota tick re-read up to 8 MB of each Claude journal, 17 % of the bridge CPU (2026-10-27).
  unit("an unchanged journal keeps its receipt without a new read", {
    given: ["a journal read once, then changed in place with its stamp kept", () => {
      const homeDir = mkdtempSync(join(tmpdir(), "amux-quota-receipt-"));
      const paneDir = join(homeDir, "repo", ".agents", "2");
      const projectDir = claudeProjectDir(paneDir, homeDir);
      const sessionPath = join(projectDir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
      const writtenAt = new Date("2026-10-27T20:00:00Z"); // whole seconds round-trip exactly
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(sessionPath, `${JSON.stringify(limitEvent())}\n`);
      utimesSync(sessionPath, writtenAt, writtenAt);
      activeClaudeLimitReceipt(paneDir, { homeDir });
      // Same length, same mtime: only a new read can see the banner gone.
      writeFileSync(sessionPath, readFileSync(sessionPath, "utf8").replace("session limit", "session lemit"));
      utimesSync(sessionPath, writtenAt, writtenAt);
      return { homeDir, paneDir };
    }],
    when: ["the receipt is asked for again", ({ homeDir, paneDir }) => activeClaudeLimitReceipt(paneDir, { homeDir })],
    then: ["the receipt read before is returned", (receipt, { homeDir }) => {
      try { expect(receipt).toMatchObject({ limitEventId: "11111111-1111-4111-8111-111111111111" }); }
      finally { rmSync(homeDir, { recursive: true, force: true }); }
    }],
  });

  // defect: 30 Oct the bridge read 109 to 261 MB per 10 s, up to 16 MB of each active journal per tick, and delivery stalled.
  unit("a growing journal without limit text is read only from where the last read ended", {
    given: ["a journal read once, an old line changed in place to a banner, then one bookkeeping line appended", () => {
      const homeDir = mkdtempSync(join(tmpdir(), "amux-quota-receipt-"));
      const paneDir = join(homeDir, "repo", ".agents", "2");
      const projectDir = claudeProjectDir(paneDir, homeDir);
      const sessionPath = join(projectDir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(sessionPath, `${JSON.stringify(limitEvent({ text: "You've hit your session lemit · resets 8:50pm (Europe/Stockholm)" }))}\n`);
      const first = activeClaudeLimitReceipt(paneDir, { homeDir });
      // Only a read of the old bytes can see this banner; an append-only journal never changes them.
      writeFileSync(sessionPath, readFileSync(sessionPath, "utf8").replace("session lemit", "session limit"));
      appendFileSync(sessionPath, `${JSON.stringify({ type: "system", uuid: "system-after" })}\n`);
      return { homeDir, paneDir, first };
    }],
    when: ["the receipt is asked for again", ({ homeDir, paneDir }) => activeClaudeLimitReceipt(paneDir, { homeDir })],
    then: ["the appended bytes alone decide, and they name no limit", (receipt, { homeDir, first }) => {
      try { expect([first, receipt]).toEqual([null, null]); }
      finally { rmSync(homeDir, { recursive: true, force: true }); }
    }],
  });

  unit("a limit banner appended to a growing journal is still read", {
    given: ["a journal read once without limit text, then a banner appended", () => {
      const homeDir = mkdtempSync(join(tmpdir(), "amux-quota-receipt-"));
      const paneDir = join(homeDir, "repo", ".agents", "2");
      const projectDir = claudeProjectDir(paneDir, homeDir);
      const sessionPath = join(projectDir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(sessionPath, `${JSON.stringify({ type: "user", uuid: "prompt", message: { content: "ship it" } })}\n`);
      const first = activeClaudeLimitReceipt(paneDir, { homeDir });
      appendFileSync(sessionPath, `${JSON.stringify(limitEvent())}\n`);
      return { homeDir, paneDir, first };
    }],
    when: ["the receipt is asked for again", ({ homeDir, paneDir }) => activeClaudeLimitReceipt(paneDir, { homeDir })],
    then: ["the new banner is the receipt", (receipt, { homeDir, first }) => {
      try {
        expect(first).toBe(null);
        expect(receipt).toMatchObject({ limitEventId: "11111111-1111-4111-8111-111111111111" });
      } finally { rmSync(homeDir, { recursive: true, force: true }); }
    }],
  });

  unit("a limit banner whose line was half written at earlier reads is still read", {
    given: ["a full read and an appended read that each saw only part of the banner's line", () => {
      const homeDir = mkdtempSync(join(tmpdir(), "amux-quota-receipt-"));
      const paneDir = join(homeDir, "repo", ".agents", "2");
      const projectDir = claudeProjectDir(paneDir, homeDir);
      const sessionPath = join(projectDir, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl");
      const banner = `${JSON.stringify(limitEvent())}\n`;
      const [first, second] = [banner.indexOf("hit your"), banner.indexOf("limit") + "limit".length];
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(sessionPath, `${JSON.stringify({ type: "user", uuid: "prompt", message: { content: "ship it" } })}\n${banner.slice(0, first)}`);
      const reads = [activeClaudeLimitReceipt(paneDir, { homeDir })];
      appendFileSync(sessionPath, banner.slice(first, second));
      reads.push(activeClaudeLimitReceipt(paneDir, { homeDir }));
      appendFileSync(sessionPath, banner.slice(second));
      return { homeDir, paneDir, reads };
    }],
    when: ["the receipt is asked for once the line is complete", ({ homeDir, paneDir }) => activeClaudeLimitReceipt(paneDir, { homeDir })],
    then: ["the completed banner is the receipt", (receipt, { homeDir, reads }) => {
      try {
        expect(reads).toEqual([null, null]);
        expect(receipt).toMatchObject({ limitEventId: "11111111-1111-4111-8111-111111111111" });
      } finally { rmSync(homeDir, { recursive: true, force: true }); }
    }],
  });

  unit("a next-day reset is resolved in the banner timezone", {
    when: ["parsing 1:10am from 23:55 Stockholm", () => parseClaudeLimitResetAt(
      "You've hit your session limit · resets 1:10am (Europe/Stockholm)",
      Date.parse("2026-07-16T21:55:00.000Z"),
    )],
    then: ["the instant belongs to the next local day", (resetAt) =>
      expect(resetAt).toBe(Date.parse("2026-07-16T23:10:00.000Z"))],
  });
});

feature("Claude quota recovery readiness", () => {
  const receipt = {
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    limitEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    limitKind: "session",
    resetAt: Date.parse("2026-07-16T18:50:00.000Z"),
  };

  unit("a manual top-up resumes before the reset clock", {
    when: ["fresh OAuth usage reports capacity", () => claudeQuotaRecoveryReadiness(receipt, {
      ok: true,
      limits: [{ kind: "session", usedPercent: 7 }],
    }, { now: Date.parse("2026-07-16T17:20:00.000Z") })],
    then: ["the API authorizes recovery", (result) =>
      expect(result).toEqual({ ready: true, via: "quota-api", usedPercent: 7 })],
  });

  unit("an unavailable API falls back only after reset plus grace", {
    when: ["checking both sides of the grace boundary", () => ({
      before: claudeQuotaRecoveryReadiness(receipt, { ok: false, error: "network_error" }, {
        now: Date.parse("2026-07-16T18:50:14.000Z"), resetGraceMs: 15_000,
      }),
      after: claudeQuotaRecoveryReadiness(receipt, { ok: false, error: "network_error" }, {
        now: Date.parse("2026-07-16T18:50:15.000Z"), resetGraceMs: 15_000,
      }),
    })],
    then: ["the clock never guesses early", ({ before, after }) => {
      expect(before.ready).toBe(false);
      expect(after).toEqual({ ready: true, via: "reset-clock" });
    }],
  });

  unit("the idempotency key includes pane, session, and limit event", {
    when: ["building recovery identity", () => quotaRecoveryJobKey("lsrc", 2, receipt)],
    then: ["the key is stable", (key) => expect(key).toBe(
      "claude-quota-recovery:lsrc:2:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    )],
  });
});

feature("Claude's current stop wording starts recovery", () => {
  // The three shapes Claude Code wrote in the last two weeks (2026-09-28).
  // None was recognized, so no stopped pane was ever resumed or announced.
  const receiptFor = (text, timestamp) => activeClaudeLimitReceiptFromEvents(
    [limitEvent({ text, timestamp })], { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  );

  unit("a spend-limit stop names the session window and its reset", {
    when: ["reading lsrc:1's stop at 02:48", () => receiptFor(
      "You've hit your monthly spend limit · raise it at claude.ai/settings/usage?from=cc_cli_limit_message · your session limit resets 3:10am (Europe/Stockholm)",
      "2026-09-28T00:48:06.000Z",
    )],
    then: ["a session receipt that resets at 03:10 Stockholm", (receipt) =>
      expect(receipt).toMatchObject({ limitKind: "session", resetAt: Date.parse("2026-09-28T01:10:00.000Z") })],
  });

  unit("a weekly stop with an hour-only reset", {
    when: ["reading a 08:41 stop that resets 9am", () => receiptFor(
      "You've hit your weekly limit · resets 9am (Europe/Stockholm)", "2026-09-23T06:41:35.579Z",
    )],
    then: ["a weekly receipt that resets the same morning", (receipt) =>
      expect(receipt).toMatchObject({ limitKind: "weekly", resetAt: Date.parse("2026-09-23T07:00:00.000Z") })],
  });

  unit("a weekly stop with a dated reset", {
    when: ["reading a Sunday stop that resets Sep 30", () => receiptFor(
      "You've hit your weekly limit · resets Sep 30, 9am (Europe/Stockholm)", "2026-09-27T19:48:57.046Z",
    )],
    then: ["the reset lands on that date", (receipt) =>
      expect(receipt).toMatchObject({ limitKind: "weekly", resetAt: Date.parse("2026-09-30T07:00:00.000Z") })],
  });

  unit("a session window that is back does not resume while the week is spent", {
    when: ["the session is fresh but the weekly limit is full", () => claudeQuotaRecoveryReadiness(
      { limitKind: "session", resetAt: null },
      { ok: true, limits: [{ kind: "session", usedPercent: 2 }, { kind: "weekly_all", usedPercent: 100, isActive: true }] },
    )],
    then: ["no resume, so no paid usage", (result) =>
      expect(result).toEqual({ ready: false, reason: "weekly-limit-still-exhausted" })],
  });
});

// The night of 2026-10-18: Claude W spent, Claude A at 97 %, Claude S (in two dirs) at 0 %.
feature("the spare Claude account for a spent week", () => {
  const usage = (weekly) => ({ ok: true, limits: [{ kind: "session", usedPercent: 0 },
    { kind: "weekly_all", usedPercent: weekly, isActive: true }] });
  const accounts = {
    "claude:login:wetterlind": { email: "w@example.test", quota: usage(100) },
    "claude:2": { email: "a@example.test", quota: usage(97) },
    "claude:1": { email: "s@example.test", quota: usage(0) },
    "claude:login:2": { email: "s@example.test", quota: usage(0) },
    "claude:login:old": { email: "old@example.test", quota: usage(0), loggedOut: true },
  };
  const profile = (key) => ({ key, id: key.split(":").at(-1) });

  unit("the account with the most weekly room wins, not one at its reserve", {
    given: ["the pane runs on the spent Claude W", () => ({ reads: [] })],
    when: ["the spare account is chosen", (ctx) => spareClaudeAccount({
      current: profile("claude:login:wetterlind"),
      catalog: Object.keys(accounts).map(profile),
      authenticated: (candidate) => !accounts[candidate.key].loggedOut,
      emailOf: (candidate) => accounts[candidate.key].email,
      readQuota: async (candidate) => { ctx.reads.push(candidate.key); return accounts[candidate.key].quota; },
      reservePercent: 90,
    }).then((spare) => ({ ...ctx, spare }))],
    then: ["Claude S in its first dir; the spent and logged-out logins are never read", ({ spare, reads }) => {
      expect(spare).toMatchObject({ profile: { key: "claude:1" }, usedPercent: 0 });
      expect(reads).toEqual(["claude:2", "claude:1", "claude:login:2"]);
    }],
  });

  unit("no account below the reserve means no move", {
    when: ["every other account is at 97 % or spent", () => spareClaudeAccount({
      current: profile("claude:login:wetterlind"),
      catalog: ["claude:login:wetterlind", "claude:2"].map(profile),
      authenticated: () => true,
      emailOf: (candidate) => accounts[candidate.key].email,
      readQuota: async (candidate) => accounts[candidate.key].quota,
    })],
    then: ["there is no spare", (spare) => expect(spare).toBeNull()],
  });
});

// 2026-10-19 08:04Z: Claude Code told claw:2 the limit was reached with a short grace
// left; claw:2 finished, committed and ended its own turn, so no stop banner was
// ever written. No recovery came and the idle alarm stayed quiet; it sat 33 min.
feature("an agent that ends its turn at Claude's grace note", () => {
  const session = "33ec8b61-8343-446a-b562-435916f76e25";
  const at = (time) => `2026-10-19T${time}Z`;
  const event = (uuid, time, fields) => ({ uuid, timestamp: at(time), sessionId: session, ...fields });
  const user = (uuid, time, content, more = {}) => event(uuid, time, { type: "user", message: { role: "user", content }, ...more });
  const assistant = (uuid, time, content, more = {}) => event(uuid, time, { type: "assistant", message: { content, ...more } });
  const claw2 = () => [
    assistant("a1", "08:04:11.444", [{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    user("r1", "08:04:11.656", [{ type: "tool_result", tool_use_id: "t1", content: "ok" }]),
    user("grace", "08:04:11.767", "[Usage limit reached; a short grace allowance remains, then this turn is cut off without warning."
      + " Judge what's left: if it's genuinely only a few steps, finish it properly, then stop and say so without extra polishing.]",
    { isMeta: true }),
    assistant("a2", "08:04:20.773", [{ type: "text", text: "Committing row 47 before I stop." }]),
    assistant("a3", "08:04:34.723", [{ type: "tool_use", id: "t2", name: "Bash", input: {} }]),
    user("r2", "08:04:37.782", [{ type: "tool_result", tool_use_id: "t2", content: "4acb726 row 47" }]),
    assistant("a4", "08:04:45.828", [{ type: "text", text: "SUMMARY: Your usage limit is reached, so I stopped." }], { stop_reason: "end_turn" }),
    event("s1", "08:04:46.103", { type: "system", subtype: "turn_duration" }),
    // The pause rule compacted the idle pane two minutes later.
    user("c0", "08:06:50.494", "/compact"),
    user("c1", "08:06:50.514", "<local-command-caveat>Caveat: the command below was run directly.</local-command-caveat>", { isMeta: true }),
    user("c2", "08:06:50.514", "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args></command-args>"),
    event("s2", "08:08:08.902", { type: "system", subtype: "compact_boundary" }),
    user("c3", "08:08:08.545", "This session is being continued from a previous conversation.", { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user("c4", "08:08:09.000", "<local-command-stdout>Compacted</local-command-stdout>"),
  ];
  const receiptOf = (events) => activeClaudeLimitReceiptFromEvents(events, { sessionId: session, sessionPath: `/sessions/${session}.jsonl` });

  unit("the grace note is the stop that recovery resumes and the idle alarm reports", {
    when: ["reading claw:2's session after it ended its turn", () => receiptOf(claw2())],
    then: ["a usage-limit receipt from the note, with the reset left to the quota reading", (receipt) => {
      expect(receipt).toMatchObject({ sessionId: session, limitEventId: "grace", limitKind: "usage", resetAt: null,
        observedAt: Date.parse(at("08:04:11.767")) });
      expect(idlePaneEvidence({ limitReceipt: receipt })).toMatchObject({ episode: "limit:grace", reason: "stopped at its usage limit" });
    }],
  });

  unit("an agent still finishing within the grace has not stopped", {
    when: ["claw:2 is committing row 47 after the note", () => receiptOf(claw2().slice(0, 6))],
    then: ["no stop yet, so nothing restarts it mid-turn", (receipt) => expect(receipt).toBeNull()],
  });

  unit("a new prompt after the grace note ends the stop", {
    when: ["claw:0 wakes claw:2 at 08:42Z", () => receiptOf([...claw2(), user("wake", "08:42:26.000", "[from claw:0]\n\nClaude S has room again; continue row 47.")])],
    then: ["no restart authority remains", (receipt) => expect(receipt).toBeNull()],
  });

  unit("Claude's own all-clear after the grace note ends the stop", {
    when: ["Claude lifts the note while the agent works on", () => receiptOf([...claw2().slice(0, 4),
      user("lifted", "08:04:30.000", "[Earlier usage-limit notes no longer apply. Continue working normally. Don't mention this to the user.]", { isMeta: true })])],
    then: ["no stop is reported", (receipt) => expect(receipt).toBeNull()],
  });
});
