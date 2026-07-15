// Quota contracts: what the gauges show must survive real payload shapes,
// partial jsonl tails and missing credentials — loudly, never silently.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import {
  normalizeClaudeUsage,
  parseCodexRateLimitEvents,
  readClaudeQuota,
  readCodexQuota,
} from "./quota-usage.mjs";

const NOW = new Date("2026-07-15T12:00:00Z").getTime();

// Captured live 2026-07-15 from the OAuth usage endpoint (values rounded).
const CLAUDE_PAYLOAD = {
  five_hour: { utilization: 43.0, resets_at: "2026-07-15T12:49:59+00:00" },
  seven_day: { utilization: 45.0, resets_at: "2026-07-21T03:59:59+00:00" },
  limits: [
    { kind: "session", group: "session", percent: 43, severity: "normal", resets_at: "2026-07-15T12:49:59+00:00", scope: null, is_active: false },
    { kind: "weekly_all", group: "weekly", percent: 45, severity: "normal", resets_at: "2026-07-21T03:59:59+00:00", scope: null, is_active: true },
    { kind: "weekly_scoped", group: "weekly", percent: 37, severity: "normal", resets_at: "2026-07-21T03:59:59+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: false },
  ],
};

const codexEventLine = ({ timestamp, usedPercent, limitId = "codex", resetsAt = 1784672247 }) => JSON.stringify({
  timestamp,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: { model_context_window: 258400 },
    rate_limits: {
      limit_id: limitId,
      primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAt },
      secondary: null,
      plan_type: "pro",
    },
  },
});

feature("Claude usage normalization", () => {
  unit("maps the limits array to gauge rows with a scoped Fable id", {
    when: ["normalizing a captured live payload", () =>
      normalizeClaudeUsage(CLAUDE_PAYLOAD, "2026-07-15T12:00:00.000Z")],
    then: ["session, weekly_all and weekly_fable rows carry percent and reset", (result) => {
      expect(result.ok).toBe(true);
      expect(result.limits.map((limit) => limit.id))
        .toEqual(["session", "weekly_all", "weekly_fable"]);
      const weekly = result.limits.find((limit) => limit.id === "weekly_all");
      expect(weekly.usedPercent).toBe(45);
      expect(weekly.resetsAt).toBe("2026-07-21T03:59:59+00:00");
      expect(weekly.isActive).toBe(true);
      expect(result.limits.find((limit) => limit.id === "weekly_fable").scopeName).toBe("Fable");
    }],
  });

  unit("a payload without usable limits is a loud typed error", {
    when: ["normalizing an empty payload", () => normalizeClaudeUsage({}, "2026-07-15T12:00:00.000Z")],
    then: ["the result is not ok and names the failure", (result) => {
      expect(result.ok).toBe(false);
      expect(result.error).toBe("no_limits_in_response");
    }],
  });

  unit("percent values are clamped to the displayable range", {
    when: ["normalizing over- and under-range percentages", () => normalizeClaudeUsage({
      limits: [
        { kind: "weekly_all", percent: 130, resets_at: "2026-07-21T03:59:59+00:00" },
        { kind: "session", percent: -4, resets_at: "2026-07-15T12:49:59+00:00" },
        { kind: "weekly_scoped", percent: "not a number" },
      ],
    }, "2026-07-15T12:00:00.000Z")],
    then: ["values clamp to 0..100 and non-numeric rows are dropped", (result) => {
      expect(result.limits).toHaveLength(2);
      expect(result.limits[0].usedPercent).toBe(100);
      expect(result.limits[1].usedPercent).toBe(0);
    }],
  });
});

feature("readClaudeQuota() credential handling", () => {
  unit("missing credentials fail loudly without a network call", {
    given: ["a fetch spy that must not be called", () => {
      const calls = [];
      return { calls, fetchImpl: async () => { calls.push(1); return { ok: true }; } };
    }],
    when: ["reading quota with a nonexistent credentials path", async (ctx) => ({
      result: await readClaudeQuota({
        credentialsPath: "/nonexistent/credentials.json",
        fetchImpl: ctx.fetchImpl,
        now: () => NOW,
      }),
      ctx,
    })],
    then: ["the error is typed and fetch stayed untouched", ({ result, ctx }) => {
      expect(result).toEqual({ ok: false, engine: "claude", error: "credentials_unavailable" });
      expect(ctx.calls).toHaveLength(0);
    }],
  });

  unit("an expired token is reported instead of silently retried", {
    given: ["a credentials file whose token expired a minute ago", () => {
      const dir = mkdtempSync(join(tmpdir(), "quota-claude-"));
      const path = join(dir, ".credentials.json");
      writeFileSync(path, JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-test", expiresAt: NOW - 60_000 },
      }));
      return path;
    }],
    when: ["reading quota", (path) => readClaudeQuota({
      credentialsPath: path,
      fetchImpl: async () => { throw new Error("must not fetch"); },
      now: () => NOW,
    })],
    then: ["the result names the expiry", (result) => {
      expect(result).toEqual({ ok: false, engine: "claude", error: "credentials_expired" });
    }],
  });

  unit("an upstream error status becomes a typed http error", {
    given: ["a valid credentials file", () => {
      const dir = mkdtempSync(join(tmpdir(), "quota-claude-"));
      const path = join(dir, ".credentials.json");
      writeFileSync(path, JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-test", expiresAt: NOW + 60_000 },
      }));
      return path;
    }],
    when: ["the usage endpoint answers 401", (path) => readClaudeQuota({
      credentialsPath: path,
      fetchImpl: async () => ({ ok: false, status: 401 }),
      now: () => NOW,
    })],
    then: ["the status is visible in the error", (result) => {
      expect(result).toEqual({ ok: false, engine: "claude", error: "http_401" });
    }],
  });
});

feature("Codex rate-limit parsing", () => {
  unit("extracts weekly window, plan and capture time from rollout lines", {
    when: ["parsing a tail with noise, a partial line and one event", () => parseCodexRateLimitEvents([
      '{"timestamp":"2026-07-15T10:00:00.000Z","type":"event_msg","payload":{"type":"agent_message"}}',
      '{"timestamp":"2026-07-15T11:09:05.887Z","ty', // torn first tail line
      codexEventLine({ timestamp: "2026-07-15T11:09:05.887Z", usedPercent: 47.0 }),
    ].join("\n"))],
    then: ["one event with a primary weekly window remains", (events) => {
      expect(events).toHaveLength(1);
      expect(events[0].limitId).toBe("codex");
      expect(events[0].planType).toBe("pro");
      expect(events[0].capturedAt).toBe("2026-07-15T11:09:05.887Z");
      expect(events[0].windows).toEqual([{
        id: "primary",
        usedPercent: 47,
        windowMinutes: 10080,
        resetsAt: new Date(1784672247 * 1000).toISOString(),
      }]);
    }],
  });

  unit("keeps the newest event per limit id across files", {
    given: ["a sessions tree where an older file has fresher data than a newer file", () => {
      const root = mkdtempSync(join(tmpdir(), "quota-codex-"));
      const day = join(root, "2026", "07", "15");
      mkdirSync(day, { recursive: true });
      writeFileSync(
        join(day, "rollout-2026-07-15T08-00-00-aaa.jsonl"),
        `${codexEventLine({ timestamp: "2026-07-15T11:30:00.000Z", usedPercent: 52.0 })}\n`,
      );
      writeFileSync(
        join(day, "rollout-2026-07-15T09-00-00-bbb.jsonl"),
        `${codexEventLine({ timestamp: "2026-07-15T10:00:00.000Z", usedPercent: 47.0 })}\n`,
      );
      return root;
    }],
    when: ["reading codex quota", (root) => readCodexQuota({ sessionsRoot: root })],
    then: ["the event with the newest capture time wins", (result) => {
      expect(result.ok).toBe(true);
      expect(result.limits).toHaveLength(1);
      expect(result.limits[0].capturedAt).toBe("2026-07-15T11:30:00.000Z");
      expect(result.limits[0].windows[0].usedPercent).toBe(52);
    }],
  });

  unit("an empty sessions tree is a loud typed error", {
    given: ["an empty temp dir", () => mkdtempSync(join(tmpdir(), "quota-codex-empty-"))],
    when: ["reading codex quota", (root) => readCodexQuota({ sessionsRoot: root })],
    then: ["the result names the missing sessions", (result) => {
      expect(result).toEqual({ ok: false, engine: "codex", error: "no_session_files" });
    }],
  });

  unit("session files without rate_limits events are a distinct error", {
    given: ["a tree whose only file has no rate_limits lines", () => {
      const root = mkdtempSync(join(tmpdir(), "quota-codex-none-"));
      const day = join(root, "2026", "07", "15");
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, "rollout-2026-07-15T08-00-00-aaa.jsonl"), '{"type":"session_meta"}\n');
      return root;
    }],
    when: ["reading codex quota", (root) => readCodexQuota({ sessionsRoot: root })],
    then: ["the error separates 'no data yet' from 'no sessions'", (result) => {
      expect(result).toEqual({ ok: false, engine: "codex", error: "no_rate_limit_events" });
    }],
  });
});
