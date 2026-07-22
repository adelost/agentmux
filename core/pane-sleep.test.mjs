import { expect, feature, unit } from "bdd-vitest";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PANE_SLEEP_IDLE_MS,
  beginSleepState,
  blockedSleepState,
  compactReceiptOk,
  cursorHash,
  findSleepCandidates,
  hasClaudeUserActivityAfterCursor,
  planSleep,
  readPaneSleepState,
  sleepingWakeDecision,
  writePaneSleepState,
} from "./pane-sleep.mjs";
import { captureJsonlAppendCursor } from "./jsonl-append-cursor.mjs";

const NOW = Date.parse("2026-07-20T12:00:00Z");

function safeFacts(overrides = {}) {
  return {
    engine: "claude",
    idleMs: PANE_SLEEP_IDLE_MS,
    busy: false,
    paneStatus: "idle",
    transportState: "empty-idle",
    liveDeliveryJobs: 0,
    worktreeClean: true,
    rebaseInProgress: false,
    processRunning: true,
    attached: false,
    excluded: false,
    ...overrides,
  };
}

feature("pane sleep fail-closed policy", () => {
  unit("only a fully proven 24-hour-idle Claude pane is allowed", {
    given: ["all exact facts", () => planSleep(safeFacts())],
    when: ["planning sleep", (result) => result],
    then: ["the plan allows it", (result) => {
      expect(result).toEqual({ allow: true, reason: "ok" });
    }],
  });

  unit("memory pressure never shortens the 24-hour threshold", {
    given: ["a clean pane idle for 23h59m", () => planSleep(safeFacts({
      idleMs: PANE_SLEEP_IDLE_MS - 60_000,
    }))],
    when: ["planning", (result) => result],
    then: ["it remains awake", (result) => {
      expect(result.reason).toBe("idle-threshold-not-met");
    }],
  });

  unit("missing activity is unknown, never infinitely idle", {
    given: ["no activity timestamp", () => planSleep(safeFacts({ idleMs: NaN }))],
    when: ["planning", (result) => result],
    then: ["it fails closed", (result) => {
      expect(result.reason).toBe("activity-unknown");
    }],
  });

  unit("an idle composer is insufficient unless the completed-work status is proven", {
    given: ["an otherwise safe pane with unknown work status", () =>
      planSleep(safeFacts({ paneStatus: "unknown" }))],
    when: ["planning", (result) => result],
    then: ["it stays awake", (result) => {
      expect(result.reason).toBe("work-not-provably-done");
    }],
  });

  unit("Codex, Kimi, attached, dirty, queued, and modal panes all refuse", {
    given: ["one fact mutation per unsafe class", () => [
      planSleep(safeFacts({ engine: "codex" })).reason,
      planSleep(safeFacts({ engine: "kimi" })).reason,
      planSleep(safeFacts({ attached: true })).reason,
      planSleep(safeFacts({ worktreeClean: false })).reason,
      planSleep(safeFacts({ liveDeliveryJobs: 1 })).reason,
      planSleep(safeFacts({ transportState: "hidden" })).reason,
    ]],
    when: ["planning each", (reasons) => reasons],
    then: ["none pass", (reasons) => {
      expect(reasons).toEqual([
        "unsupported-engine",
        "unsupported-engine",
        "pane-attached-or-unknown",
        "dirty-or-unknown-worktree",
        "live-or-unknown-delivery",
        "modal-input-or-unknown",
      ]);
    }],
  });

  unit("candidate scan admits only the same real policy", {
    given: ["one exact candidate and three false lookalikes", () => findSleepCandidates({
      nowMs: NOW,
      panes: [
        { key: "ai:1", lastActivityMs: NOW - PANE_SLEEP_IDLE_MS, ...safeFacts() },
        { key: "ai:2", lastActivityMs: null, ...safeFacts() },
        { key: "ai:3", lastActivityMs: NOW - PANE_SLEEP_IDLE_MS, ...safeFacts({ engine: "kimi" }) },
        { key: "ai:4", lastActivityMs: NOW - PANE_SLEEP_IDLE_MS, ...safeFacts({ attached: true }) },
      ],
    })],
    when: ["scanning", (candidates) => candidates],
    then: ["only ai:1 remains", (candidates) => {
      expect(candidates).toEqual([{ key: "ai:1", idleMs: PANE_SLEEP_IDLE_MS }]);
    }],
  });
});

feature("durable sleep lifecycle", () => {
  unit("generation increments and a blocked transition preserves provenance", {
    given: ["an existing generation and private temp state root", () => {
      const rootDir = mkdtempSync(join(tmpdir(), "amux-pane-sleep-"));
      const armed = beginSleepState({
        previous: { sleepGeneration: 4 },
        agentName: "lsrc",
        pane: 3,
        sessionId: "session-a",
        processGeneration: "boot:pid:start",
        nowMs: NOW,
      });
      return { rootDir, armed };
    }],
    when: ["writing arming then blocked", ({ rootDir, armed }) => {
      writePaneSleepState(armed, { rootDir });
      writePaneSleepState(blockedSleepState(armed, "new-delivery", NOW + 1), { rootDir });
      return { rootDir, value: readPaneSleepState("lsrc", 3, { rootDir }) };
    }],
    then: ["generation/session remain and reason is durable", ({ rootDir, value }) => {
      expect(value).toMatchObject({
        status: "blocked",
        sleepGeneration: 5,
        sessionId: "session-a",
        processGeneration: "boot:pid:start",
        blockedReason: "new-delivery",
      });
      rmSync(rootDir, { recursive: true, force: true });
    }],
  });

  unit("wake accepts only asleep or wake_pending with the exact session", {
    given: ["one asleep manifest", () => ({
      version: 1,
      status: "asleep",
      sessionId: "exact",
      sleepGeneration: 2,
    })],
    when: ["checking exact, wrong, and arming states", (state) => [
      sleepingWakeDecision({ state, sessionId: "exact" }),
      sleepingWakeDecision({ state, sessionId: "other" }),
      sleepingWakeDecision({ state: { ...state, status: "arming" }, sessionId: "exact" }),
    ]],
    then: ["only the exact asleep session is admitted", ([exact, wrong, arming]) => {
      expect(exact).toEqual({ ok: true, tracked: true, reason: "exact-sleep-session" });
      expect(wrong.reason).toBe("sleep-session-mismatch");
      expect(arming.reason).toBe("sleep-state-arming");
    }],
  });
});

feature("machine-verifiable compact receipt", () => {
  unit("all bound fields and the exact nonce response are required", {
    given: ["a complete receipt", () => ({
      version: 1,
      engine: "claude",
      sleepGeneration: 1,
      sessionId: "session",
      compactBoundary: true,
      compactCursorHash: "0123456789abcdef",
      nonce: "12345678",
      response: "AMUX_SLEEP_CHECK_12345678_OK",
      observations: 2,
      noActivityAfterCheck: true,
    })],
    when: ["checking complete and mutated receipts", (receipt) => [
      compactReceiptOk(receipt),
      compactReceiptOk({ ...receipt, response: "OK" }),
      compactReceiptOk({ ...receipt, compactBoundary: false }),
      compactReceiptOk({ ...receipt, observations: 1 }),
    ]],
    then: ["only the complete receipt passes", (results) => {
      expect(results).toEqual([true, false, false, false]);
    }],
  });

  unit("a cursor hash is stable and user activity after it is detected", {
    given: ["one append-only journal cursor", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-sleep-cursor-"));
      const file = join(root, "session.jsonl");
      appendFileSync(file, `${JSON.stringify({ type: "assistant", message: { content: [] } })}\n`);
      const cursor = captureJsonlAppendCursor("sleep-test", [file]);
      return { root, file, cursor, hash: cursorHash(cursor) };
    }],
    when: ["reading before and after a new user event", (fixture) => {
      const before = hasClaudeUserActivityAfterCursor(fixture.cursor);
      appendFileSync(fixture.file, `${JSON.stringify({ type: "user", message: { content: "new work" } })}\n`);
      const after = hasClaudeUserActivityAfterCursor(fixture.cursor);
      return { ...fixture, before, after };
    }],
    then: ["the stable hash remains and only the appended user event trips the fence", (fixture) => {
      expect(fixture.hash).toMatch(/^[0-9a-f]{16}$/u);
      expect(fixture.before).toBe(false);
      expect(fixture.after).toBe(true);
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });
});
