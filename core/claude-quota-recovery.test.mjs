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
  unit("an exact terminal limit response is bound to its persisted session", {
    given: ["a mid-turn limit followed only by bookkeeping", () => [
      { type: "assistant", uuid: "tool", message: { content: [{ type: "tool_use", name: "Bash" }] } },
      { type: "user", uuid: "result", message: { content: [{ type: "tool_result", content: "ok" }] } },
      limitEvent(),
      { type: "system", uuid: "system-after", timestamp: "2026-07-16T17:01:11.040Z" },
      { type: "file-history-snapshot" },
    ]],
    when: ["extracting the active receipt", (events) => activeClaudeLimitReceiptFromEvents(events, {
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      sessionPath: "/sessions/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jsonl",
    })],
    then: ["the exact event, session, and absolute Stockholm reset survive", (receipt) => {
      expect(receipt).toMatchObject({
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        limitEventId: "11111111-1111-4111-8111-111111111111",
        limitKind: "session",
        observedAt: Date.parse("2026-07-16T17:01:11.018Z"),
        resetAt: Date.parse("2026-07-16T18:50:00.000Z"),
      });
    }],
  });

  unit("a manual continuation supersedes automatic recovery", {
    given: ["a later real user turn after the limit", () => [
      limitEvent(),
      { type: "user", uuid: "manual", timestamp: "2026-07-16T17:16:46.827Z", message: { content: "continue" } },
    ]],
    when: ["checking whether the limit is still active", (events) =>
      activeClaudeLimitReceiptFromEvents(events, { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })],
    then: ["automatic restart refuses to race the human", (receipt) => expect(receipt).toBeNull()],
  });

  unit("the filesystem reader binds the banner to the pane's newest persisted session", {
    given: ["an actual Claude project JSONL under an isolated HOME", () => {
      const homeDir = mkdtempSync(join(tmpdir(), "amux-quota-receipt-"));
      const paneDir = join(homeDir, "repo", ".agents", "2");
      const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const projectDir = claudeProjectDir(paneDir, homeDir);
      const sessionPath = join(projectDir, `${sessionId}.jsonl`);
      mkdirSync(projectDir, { recursive: true });
      writeFileSync(sessionPath, `${JSON.stringify(limitEvent())}\n`);
      return { homeDir, paneDir, sessionId, sessionPath };
    }],
    when: ["reading through the production identity and bounded-tail seams", (ctx) => ({
      ...ctx,
      receipt: activeClaudeLimitReceipt(ctx.paneDir, { homeDir: ctx.homeDir }),
    })],
    then: ["the exact file, session, and limit event form one restart receipt", (ctx) => {
      expect(ctx.receipt).toMatchObject({
        sessionId: ctx.sessionId,
        sessionPath: ctx.sessionPath,
        limitEventId: "11111111-1111-4111-8111-111111111111",
      });
      rmSync(ctx.homeDir, { recursive: true, force: true });
    }],
  });

  unit("prose that quotes a limit banner is not restart authority", {
    given: ["an ordinary assistant explanation", () => [{
      type: "assistant",
      uuid: "quoted",
      timestamp: "2026-07-16T17:01:11.018Z",
      message: { content: [{ type: "text", text: "The pane said: You've hit your session limit · resets 8:50pm" }] },
    }]],
    when: ["extracting a receipt", (events) =>
      activeClaudeLimitReceiptFromEvents(events, { sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" })],
    then: ["no receipt is minted", (receipt) => expect(receipt).toBeNull()],
  });

  unit("a next-day reset is resolved in the banner timezone", {
    when: ["parsing 1:10am from a 23:55 Stockholm banner", () => parseClaudeLimitResetAt(
      "You've hit your session limit · resets 1:10am (Europe/Stockholm)",
      Date.parse("2026-07-16T21:55:00.000Z"),
    )],
    then: ["the reset belongs to the next local day", (resetAt) =>
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

  unit("a manual top-up resumes before the scheduled reset", {
    when: ["the fresh OAuth usage endpoint reports session capacity", () =>
      claudeQuotaRecoveryReadiness(receipt, {
        ok: true,
        limits: [{ kind: "session", usedPercent: 7, isActive: false }],
      }, { now: Date.parse("2026-07-16T17:20:00.000Z") })],
    then: ["recovery is authorized by the live API", (result) =>
      expect(result).toEqual({ ready: true, via: "quota-api", usedPercent: 7 })],
  });

  unit("an unavailable API falls back only after the exact reset plus grace", {
    when: ["checking before and after the reset", () => ({
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

  unit("the continuation idempotency key is exact to pane, session, and limit event", {
    when: ["building the recovery identity", () => quotaRecoveryJobKey("lsrc", 2, receipt)],
    then: ["the identity is stable and collision-resistant across episodes", (key) =>
      expect(key).toBe("claude-quota-recovery:lsrc:2:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")],
  });
});
