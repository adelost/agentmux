import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import {
  CLAUDE_NETWORK_RETRY_MS,
  CLAUDE_USAGE_MIN_INTERVAL_MS,
  claudeQuotaBudgetKey,
  readClaudeQuotaBudgeted,
  readClaudeQuotaHistory,
} from "./claude-quota-budget.mjs";

const NOW = Date.parse("2026-10-10T08:00:00Z");
const slot = (id) => ({ provider: "claude", id, key: `claude:${id}`, label: `claude ${id}`,
  source: "primary", credentialsPath: `/profiles/${id}/.credentials.json` });
const sameAccount = () => ({ email: "adelost@example.com", organization: null });
const usage = (profile, resetsAt = "2026-10-10T12:00:00Z") => ({
  ok: true, provider: "claude", profile: { id: profile.id, key: profile.key },
  limits: [{ kind: "session", usedPercent: 40, resetsAt }],
});

const budget = (overrides = {}) => {
  const budgetDir = mkdtempSync(join(tmpdir(), "amux-claude-budget-"));
  const read = vi.fn(async ({ profile }) => usage(profile));
  return { budgetDir, read, identityOf: sameAccount, sleep: async () => {}, ...overrides };
};

feature("one Claude usage call per account per five minutes", () => {
  unit("cache-only reminder reads never spend provider budget", {
    given: ["a cold usage cache", () => budget()],
    when: ["a reminder, dashboard and second reminder read", async ctx => {
      const cold = await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), cacheOnly: true, now: () => NOW });
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW });
      const warm = await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), cacheOnly: true, now: () => NOW });
      return { ctx, cold, warm };
    }],
    then: ["only the dashboard calls the provider", ({ ctx, cold, warm }) => {
      expect(cold.error).toBe("quota_cache_unavailable");
      expect(warm.ok).toBe(true);
      expect(ctx.read).toHaveBeenCalledTimes(1);
    }],
  });
  unit("a second slot on the same account reuses the first read, labelled as its own slot", {
    given: ["one fresh read through slot 1", async () => {
      const ctx = budget();
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW });
      return ctx;
    }],
    when: ["slot 2 reads four minutes later", (ctx) =>
      readClaudeQuotaBudgeted({ ...ctx, profile: slot("2"), now: () => NOW + 4 * 60_000 })],
    then: ["no second usage call, and recovery sees slot 2's key", (result, ctx) => {
      expect(ctx.read).toHaveBeenCalledTimes(1);
      expect(result.profile.key).toBe("claude:2");
      expect(result.limits[0].usedPercent).toBe(40);
    }],
  });

  unit("the budget reopens after five minutes or when a window has reset", {
    given: ["a read whose session window resets two minutes later", async () => {
      const ctx = budget({ read: vi.fn(async ({ profile }) => usage(profile, "2026-10-10T08:02:00Z")) });
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW });
      return ctx;
    }],
    when: ["reading at minute 3 (window reset) and at minute 9 after that", async (ctx) => {
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW + 3 * 60_000 });
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"),
        now: () => NOW + 3 * 60_000 + CLAUDE_USAGE_MIN_INTERVAL_MS });
    }],
    then: ["each of the three reads went to the provider", (_, ctx) => {
      expect(ctx.read).toHaveBeenCalledTimes(3);
    }],
  });

  unit("a parked pane never resumes on a read older than its limit event", {
    given: ["a read one minute before the pane hit its limit", async () => {
      const ctx = budget();
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW });
      return ctx;
    }],
    when: ["recovery asks for a read not older than the limit event", (ctx) =>
      readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), notBefore: NOW + 60_000,
        now: () => NOW + 90_000 })],
    then: ["the provider is asked again", (_, ctx) => {
      expect(ctx.read).toHaveBeenCalledTimes(2);
    }],
  });

  unit("a failure that never reached the provider spends no budget", {
    given: ["a read refused locally because a pane holds the refresh lock", async () => {
      const ctx = budget({ read: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: "refresh_busy" })
        .mockImplementation(async ({ profile }) => usage(profile)) });
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW });
      return ctx;
    }],
    when: ["reading again a few seconds later", (ctx) =>
      readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW + 5_000 })],
    then: ["the retry reaches the provider", (result, ctx) => {
      expect(ctx.read).toHaveBeenCalledTimes(2);
      expect(result.ok).toBe(true);
    }],
  });

  unit("while another process holds the account's read, nothing is fetched twice", {
    given: ["a live read lock and no stored result", () => {
      const ctx = budget();
      mkdirSync(join(ctx.budgetDir, `${claudeQuotaBudgetKey(slot("1"), sameAccount())}.lock`));
      return ctx;
    }],
    when: ["reading", (ctx) => readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW })],
    then: ["the reader is untouched and the result says busy", (result, ctx) => {
      expect(ctx.read).not.toHaveBeenCalled();
      expect(result.error).toBe("quota_read_busy");
    }],
  });

  unit("each paid reading adds one weekly point for the forecast, a reused one adds none", {
    given: ["weekly readings of 40 % and then 42 % five minutes apart", () => {
      const weekly = (usedPercent) => ({ ok: true, provider: "claude",
        limits: [{ kind: "weekly_all", usedPercent, resetsAt: "2026-10-14T07:00:00Z" }] });
      return budget({ read: vi.fn().mockResolvedValueOnce(weekly(40)).mockResolvedValueOnce(weekly(42)) });
    }],
    when: ["reading three times, the second inside the budget window", async (ctx) => {
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW });
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("2"), now: () => NOW + 60_000 });
      await readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW + CLAUDE_USAGE_MIN_INTERVAL_MS });
      return readClaudeQuotaHistory(slot("2"), ctx);
    }],
    then: ["the account's history holds the two paid readings, in order", (history) => {
      expect(history.map((point) => [point.at - NOW, point.usedPercent])).toEqual([
        [0, 40], [CLAUDE_USAGE_MIN_INTERVAL_MS, 42],
      ]);
    }],
  });
});

// 2026-10-17: one dropped request stood five minutes in every reader, and the stats push missed Claude W.
feature("a reading that got no answer stands one minute", () => {
  unit("a network error is read again after a minute, a provider refusal only after five", {
    given: ["one account whose reads fail by network, then by a 429", () => {
      const results = [{ ok: false, error: "network_error", cause: "TimeoutError" }, usage(slot("1")),
        { ok: false, error: "http_429" }, usage(slot("1"))];
      return budget({ read: vi.fn(async () => results.shift()) });
    }],
    when: ["reading just before and after each window", async (ctx) => {
      const at = (ms) => readClaudeQuotaBudgeted({ ...ctx, profile: slot("1"), now: () => NOW + ms });
      const seen = [];
      for (const ms of [0, CLAUDE_NETWORK_RETRY_MS - 1, CLAUDE_NETWORK_RETRY_MS,
        10 * 60_000, 10 * 60_000 + CLAUDE_NETWORK_RETRY_MS, 10 * 60_000 + CLAUDE_USAGE_MIN_INTERVAL_MS]) {
        seen.push((await at(ms)).error ?? "ok");
      }
      return { ctx, seen };
    }],
    then: ["the network error clears after its minute and the refusal holds its five", ({ ctx, seen }) => {
      expect(seen).toEqual(["network_error", "network_error", "ok", "http_429", "http_429", "ok"]);
      expect(ctx.read).toHaveBeenCalledTimes(4);
    }],
  });
});
