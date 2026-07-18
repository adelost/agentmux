import { describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  hasCodexTurnBoundaryAfterSubmit,
  recoverClosedCodexSubmit,
} from "./codex-submit-boundary.mjs";

const event = (type, timestamp) => JSON.stringify({
  type: "event_msg", timestamp: new Date(timestamp).toISOString(),
  payload: { type, turn_id: "turn-1" },
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "amux-codex-submit-boundary-"));
  const file = join(root, "rollout.jsonl");
  writeFileSync(file, "");
  const cursor = { kind: "codex-prompt-events-v1", positions: { [file]: 0 } };
  return { root, file, cursor, cleanup: () => rmSync(root, { recursive: true, force: true }) };
};

describe("Codex submit turn boundary", () => {
  it.each(["task_complete", "turn_aborted"])(
    "accepts a newer %s event but no foreign or older boundary", (type) => {
      const fx = fixture();
      try {
        appendFileSync(fx.file, `${event(type, 10_001)}\n`);
        expect(hasCodexTurnBoundaryAfterSubmit(fx.cursor, 10_000)).toBe(true);
        expect(hasCodexTurnBoundaryAfterSubmit(fx.cursor, 10_002)).toBe(false);
        expect(hasCodexTurnBoundaryAfterSubmit(
          { kind: "claude-prompt-events-v1", positions: { [fx.file]: 0 } }, 10_000,
        )).toBe(false);
      } finally { fx.cleanup(); }
    },
  );

  it("returns a proven non-ingested submit to pending and preserves cancellation", async () => {
    const fx = fixture();
    try {
      appendFileSync(fx.file, `${event("turn_aborted", 11_000)}\n`);
      const job = { id: "job-1", status: "submitted", kind: "prompt", text: "message",
        agentName: "lsrc", pane: 4, submittedAt: 10_000, echoCursor: fx.cursor,
        cancelRequestedAt: 10_500, metadata: { sender: "claw:5" } };
      let stored = job;
      const queue = {
        read: () => stored,
        update: (_current, patch) => { stored = { ...stored, ...patch }; return stored; },
      };
      const onRecovered = vi.fn();
      const result = await recoverClosedCodexSubmit({
        job, queue, now: () => 80_000,
        agent: { promptTransportState: async () => ({ state: "empty-idle", busy: false }) },
        exactEcho: async () => false, acknowledge: vi.fn(), onRecovered,
      });
      expect(result).toMatchObject({ status: "pending", submittedAt: null, echoCursor: null,
        cancelRequestStatus: "requested", metadata: {
          submittedRecoveryKind: "closed-codex-turn-resend",
        } });
      expect(onRecovered).toHaveBeenCalledOnce();
    } finally { fx.cleanup(); }
  });

  it("keeps the fence when the turn is live, the composer is not empty, or the boundary is young", async () => {
    const fx = fixture();
    try {
      appendFileSync(fx.file, `${event("task_complete", 11_000)}\n`);
      const base = { id: "job-1", status: "submitted", kind: "prompt", text: "message",
        agentName: "lsrc", pane: 4, submittedAt: 10_000, echoCursor: fx.cursor };
      const run = (job, transport, now = 80_000) => recoverClosedCodexSubmit({
        job, now: () => now, agent: { promptTransportState: async () => transport },
        queue: { read: () => job, update: vi.fn() }, exactEcho: async () => false,
        acknowledge: vi.fn(), onRecovered: vi.fn(),
      });
      expect(await run(base, { state: "drafted", busy: false })).toBeNull();
      expect(await run(base, { state: "empty-busy", busy: true })).toBeNull();
      expect(await run(base, { state: "empty-idle", busy: false }, 69_999)).toBeNull();
      writeFileSync(fx.file, "");
      expect(await run(base, { state: "empty-idle", busy: false })).toBeNull();
    } finally { fx.cleanup(); }
  });

  it("acknowledges a late exact echo instead of redispatching", async () => {
    const fx = fixture();
    try {
      appendFileSync(fx.file, `${event("task_complete", 11_000)}\n`);
      const job = { id: "job-1", status: "submitted", kind: "prompt", text: "message",
        agentName: "lsrc", pane: 4, submittedAt: 10_000, echoCursor: fx.cursor };
      const acknowledge = vi.fn(async (_job, via) => ({ status: "acknowledged", via }));
      const result = await recoverClosedCodexSubmit({
        job, now: () => 80_000,
        agent: { promptTransportState: async () => ({ state: "empty-idle", busy: false }) },
        queue: { read: () => job, update: vi.fn() }, exactEcho: async () => true,
        acknowledge, onRecovered: vi.fn(),
      });
      expect(result).toEqual({ status: "acknowledged",
        via: "late-echo-after-codex-turn-boundary" });
      expect(acknowledge).toHaveBeenCalledOnce();
    } finally { fx.cleanup(); }
  });
});
