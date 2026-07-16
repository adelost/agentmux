import { describe, expect, it, vi } from "vitest";
import {
  createNativeClaudeQuotaRetryScheduler,
  nativeClaudeQuotaCandidate,
  nativeClaudeQuotaReceipt,
} from "./native-claude-quota.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";
const TEXT = "You've hit your session limit · resets 12am (Europe/Stockholm)";

const assistantEvent = (overrides = {}) => ({
  type: "assistant",
  error: "rate_limit",
  session_id: SESSION,
  uuid: "quota-assistant",
  timestamp: "2026-07-16T19:13:37.132Z",
  message: {
    model: "<synthetic>",
    content: [{ type: "text", text: TEXT }],
  },
  ...overrides,
});

const resultEvent = (overrides = {}) => ({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 429,
  terminal_reason: "api_error",
  session_id: SESSION,
  uuid: "quota-result",
  num_turns: 1,
  result: TEXT,
  usage: {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  },
  modelUsage: {},
  ...overrides,
});

describe("native Claude quota evidence", () => {
  it("accepts only the exact synthetic assistant and zero-work 429 pair", () => {
    const candidate = nativeClaudeQuotaCandidate(assistantEvent());
    expect(candidate).toMatchObject({
      sessionId: SESSION,
      limitEventId: "quota-assistant",
      limitKind: "session",
      text: TEXT,
    });
    expect(nativeClaudeQuotaReceipt(resultEvent(), {
      candidate,
      sessionId: SESSION,
    })).toMatchObject({
      backend: "native",
      sessionId: SESSION,
      limitEventId: "quota-result",
    });
  });

  it.each([
    ["tool activity", { hadToolActivity: true }, {}],
    ["assistant text", { hadAssistantText: true }, {}],
    ["token usage", {}, { usage: { input_tokens: 1 } }],
    ["multiple turns", {}, { num_turns: 2 }],
    ["another session", {}, { session_id: "22222222-2222-4222-8222-222222222222" }],
    ["another status", {}, { api_error_status: 500 }],
  ])("refuses automatic replay after %s", (_label, state, result) => {
    const candidate = nativeClaudeQuotaCandidate(assistantEvent());
    expect(nativeClaudeQuotaReceipt(resultEvent(result), {
      candidate,
      sessionId: SESSION,
      ...state,
    })).toBeNull();
  });

  it("refuses lookalike quota prose from a real assistant", () => {
    expect(nativeClaudeQuotaCandidate(assistantEvent({
      error: undefined,
      message: { model: "claude-opus-4-8", content: [{ type: "text", text: TEXT }] },
    }))).toBeNull();
  });
});

describe("native Claude quota retry scheduler", () => {
  it("coalesces duplicate arms and retries exactly once when quota is ready", async () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn(async () => {});
      const readQuota = vi.fn(async () => ({
        ok: true,
        engine: "claude",
        limits: [{ kind: "session", usedPercent: 14 }],
      }));
      const scheduler = createNativeClaudeQuotaRetryScheduler({
        readQuota,
        onReady,
        pollMs: 1_000,
      });
      const receipt = nativeClaudeQuotaReceipt(resultEvent(), {
        candidate: nativeClaudeQuotaCandidate(assistantEvent()),
        sessionId: SESSION,
      });

      expect(scheduler.arm("delivery:one", receipt)).toBe(true);
      expect(scheduler.arm("delivery:one", receipt)).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(readQuota).toHaveBeenCalledTimes(1);
      expect(onReady).toHaveBeenCalledTimes(1);
      expect(onReady).toHaveBeenCalledWith("delivery:one", receipt,
        expect.objectContaining({ ready: true, via: "quota-api" }));
      expect(scheduler.size()).toBe(0);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays armed while the account still reports 100 percent", async () => {
    vi.useFakeTimers();
    try {
      const onReady = vi.fn();
      const scheduler = createNativeClaudeQuotaRetryScheduler({
        readQuota: async () => ({
          ok: true,
          engine: "claude",
          limits: [{ kind: "session", usedPercent: 100 }],
        }),
        onReady,
        pollMs: 500,
      });
      const receipt = nativeClaudeQuotaReceipt(resultEvent(), {
        candidate: nativeClaudeQuotaCandidate(assistantEvent()),
        sessionId: SESSION,
      });
      scheduler.arm("delivery:one", receipt);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(onReady).not.toHaveBeenCalled();
      expect(scheduler.size()).toBe(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
