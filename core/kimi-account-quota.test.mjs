import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import {
  KIMI_QUOTA_SOURCE,
  KIMI_USAGE_URL,
  normalizeKimiQuota,
  readKimiAccountQuota,
} from "./kimi-account-quota.mjs";

const NOW = Date.parse("2026-07-27T03:00:00.000Z");
const PROFILE = {
  provider: "kimi",
  id: "1",
  key: "kimi:1",
  label: "Kimi 1",
  source: "primary",
};

const token = (sub = "account-one") => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ iss: "kimi-auth", sub })}.signature`;
};

const payload = {
  membership: { name: "Allegretto" },
  usage: {
    limit: 1_000,
    used: 420,
    reset_at: "2026-08-02T03:00:00Z",
  },
  limits: [{
    window: { duration: 300, timeUnit: "MINUTE" },
    detail: { limit: 100, remaining: 25, reset_in: 1800 },
  }],
};

const profileFile = (credentials) => {
  const home = mkdtempSync(join(tmpdir(), "amux-kimi-profile-"));
  const credentialsPath = join(home, "kimi-code.json");
  writeFileSync(credentialsPath, JSON.stringify(credentials));
  return { ...PROFILE, credentialsPath };
};

feature("Kimi Code subscription quota", () => {
  unit("maps the weekly summary and rolling window without exposing OAuth", {
    when: ["normalizing Kimi's documented usage shape", () => normalizeKimiQuota(
      PROFILE,
      payload,
      { access_token: token() },
      new Date(NOW).toISOString(),
    )],
    then: ["the tightest allowance leads and identity is only a fingerprint", (result) => {
      expect(result).toMatchObject({
        ok: true,
        provider: "kimi",
        account: { email: null, plan: "Allegretto" },
        observation: {
          source: KIMI_QUOTA_SOURCE,
          usedPercent: 75,
          remainingPercent: 25,
          resetsAt: "2026-07-27T03:30:00.000Z",
        },
      });
      expect(result.limits.map((row) => [row.scopeName, row.usedPercent]))
        .toEqual([["Vecka", 42], ["5 h", 75]]);
      expect(result.account.identityKey).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
      expect(JSON.stringify(result)).not.toContain("account-one");
      expect(JSON.stringify(result)).not.toContain("signature");
    }],
  });

  unit("a profile without credentials asks for login and never fetches", {
    given: ["a missing credential path and fetch spy", () => {
      const calls = [];
      return {
        profile: { ...PROFILE, credentialsPath: "/nonexistent/kimi-code.json" },
        calls,
        fetchImpl: async () => { calls.push(1); },
      };
    }],
    when: ["collecting the profile", async (ctx) => ({
      ctx,
      result: await readKimiAccountQuota(ctx.profile, {
        fetchImpl: ctx.fetchImpl,
        now: () => NOW,
      }),
    })],
    then: ["the typed state is actionable and no network write occurs", ({ ctx, result }) => {
      expect(result).toMatchObject({ ok: false, provider: "kimi", error: "login_required" });
      expect(ctx.calls).toEqual([]);
    }],
  });

  unit("an expired token stays provider-owned instead of being refreshed by agentmux", {
    given: ["an expired Kimi credential", () => profileFile({
      access_token: token(),
      refresh_token: "never-read-by-test",
      expires_at: NOW / 1000 - 1,
    })],
    when: ["collecting quota", (profile) => readKimiAccountQuota(profile, {
      fetchImpl: async () => { throw new Error("must not fetch"); },
      now: () => NOW,
    })],
    then: ["the UI is told to run Kimi login", (result) => {
      expect(result).toMatchObject({ ok: false, error: "credentials_expired" });
      expect(JSON.stringify(result)).not.toContain("never-read-by-test");
    }],
  });

  unit("one bounded provider GET produces a fresh observation", {
    given: ["a valid profile and captured usage response", () => ({
      profile: profileFile({
        access_token: token(),
        refresh_token: "not-exported",
        expires_at: NOW / 1000 + 3_600,
      }),
      calls: [],
    })],
    when: ["collecting the profile", async (ctx) => {
      const result = await readKimiAccountQuota(ctx.profile, {
        now: () => NOW,
        fetchImpl: async (url, options) => {
          ctx.calls.push({ url, options });
          return { ok: true, status: 200, json: async () => payload };
        },
      });
      return { ctx, result };
    }],
    then: ["the collector calls only the usage endpoint and returns no bearer", ({ ctx, result }) => {
      expect(ctx.calls).toHaveLength(1);
      expect(ctx.calls[0].url).toBe(KIMI_USAGE_URL);
      expect(ctx.calls[0].options.signal).toBeInstanceOf(AbortSignal);
      expect(result.ok).toBe(true);
      expect(JSON.stringify(result)).not.toContain("not-exported");
    }],
  });

  unit("an empty provider response is a loud typed error", {
    when: ["normalizing no limits", () => normalizeKimiQuota(
      PROFILE, {}, { access_token: token() }, new Date(NOW).toISOString(),
    )],
    then: ["the profile remains visible but unavailable", (result) => {
      expect(result).toMatchObject({ ok: false, provider: "kimi", error: "no_limits_in_response" });
    }],
  });
});
