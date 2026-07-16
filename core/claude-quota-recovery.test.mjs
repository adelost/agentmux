import { feature, unit, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeClaudeLimitReceipt,
  activeClaudeLimitReceiptFromEvents,
  claudeQuotaRecoveryReadiness,
  parseClaudeLimitResetAt,
  quotaRecoveryJobKey,
} from "./claude-quota-recovery.mjs";
import { claudeProjectDir } from "./claude-paths.mjs";

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
