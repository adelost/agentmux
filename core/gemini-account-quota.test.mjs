import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import {
  GEMINI_LOAD_URL,
  GEMINI_QUOTA_URL,
  GEMINI_TOKEN_URL,
  normalizeGeminiQuota,
  readGeminiAccountQuota,
} from "./gemini-account-quota.mjs";

const NOW = Date.parse("2026-07-27T01:00:00Z");
const idToken = (email) => `x.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.x`;
const PROFILE = { id: "2", key: "gemini:2", label: "Google 2", source: "windows" };
const quota = { buckets: [
  { modelId: "gemini-pro", remainingFraction: 0.35, resetTime: "2026-07-28T01:00:00Z" },
  { modelId: "gemini-flash", remainingFraction: 0.8, resetTime: "2026-07-27T02:00:00Z" },
] };

feature("Gemini coding subscription quota", () => {
  unit("normalizes the tightest model bucket and account identity", {
    when: ["mapping one OAuth quota response", () => normalizeGeminiQuota(
      PROFILE, quota, { paidTier: { name: "Google AI Ultra" } },
      { id_token: idToken("two@example.com") }, "2026-07-27T01:00:00Z")],
    then: ["the provider observation reports 35% remaining", (result) => {
      expect(result).toMatchObject({
        ok: true,
        account: { email: "two@example.com", plan: "Google AI Ultra" },
        observation: { usedPercent: 65, remainingPercent: 35 },
      });
    }],
  });

  unit("drops provider sentinel resets from 1970", {
    when: ["normalizing an exhausted bucket with the sentinel clock", () => normalizeGeminiQuota(
      PROFILE, { buckets: [{ modelId: "gemini-pro", remainingFraction: 0,
        resetTime: "1970-01-01T00:00:00Z" }] }, {},
      { id_token: idToken("two@example.com") }, "2026-07-27T01:00:00Z")],
    then: ["the exhausted quota remains but the fake reset does not", (result) => {
      expect(result.observation).toMatchObject({ usedPercent: 100, resetsAt: null });
      expect(result.limits[0].resetsAt).toBeNull();
    }],
  });

  unit("refreshes expired CLI OAuth then reads tier and quota without a model turn", {
    given: ["an expired Gemini CLI profile", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-gemini-profile-"));
      const credentialsPath = join(root, "oauth_creds.json");
      writeFileSync(credentialsPath, JSON.stringify({
        access_token: "old", refresh_token: "refresh", id_token: idToken("two@example.com"),
        expiry_date: NOW - 1,
      }));
      const profile = { ...PROFILE, home: root, credentialsPath };
      const urls = [];
      const fetchImpl = vi.fn(async (url, request) => {
        urls.push(url);
        if (url === GEMINI_TOKEN_URL) {
          return { ok: true, status: 200, json: async () => ({
            access_token: "fresh", expires_in: 3600,
          }) };
        }
        if (url === GEMINI_LOAD_URL) {
          expect(request.headers.authorization).toBe("Bearer fresh");
          return { ok: true, status: 200, json: async () => ({
            currentTier: { id: "standard-tier" }, cloudaicompanionProject: "project-1",
          }) };
        }
        return { ok: true, status: 200, json: async () => quota };
      });
      return { profile, credentialsPath, fetchImpl, urls };
    }],
    when: ["collecting the profile", (ctx) => readGeminiAccountQuota(ctx.profile, {
      fetchImpl: ctx.fetchImpl,
      oauthClient: { clientId: "public-client", clientSecret: "public-secret" },
      now: () => NOW,
    })],
    then: ["one refresh and two quota reads succeed", (result, ctx) => {
      expect(result.ok).toBe(true);
      expect(ctx.urls).toEqual([GEMINI_TOKEN_URL, GEMINI_LOAD_URL, GEMINI_QUOTA_URL]);
      expect(JSON.parse(readFileSync(ctx.credentialsPath, "utf8")).access_token).toBe("fresh");
      expect(JSON.stringify(result)).not.toContain("access_token");
    }],
  });

  unit("classifies Google's consumer migration instead of showing generic auth failure", {
    given: ["a fresh OAuth credential and unsupported-client response", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-gemini-moved-"));
      const credentialsPath = join(root, "oauth_creds.json");
      writeFileSync(credentialsPath, JSON.stringify({
        access_token: "token", refresh_token: "refresh",
        id_token: idToken("two@example.com"), expiry_date: NOW + 60_000,
      }));
      return {
        profile: { ...PROFILE, home: root, credentialsPath },
        fetchImpl: vi.fn(async () => ({
          ok: false, status: 403,
          json: async () => ({ error: { message: "UNSUPPORTED_CLIENT: migrate to Antigravity" } }),
        })),
      };
    }],
    when: ["collecting", (ctx) =>
      readGeminiAccountQuota(ctx.profile, { fetchImpl: ctx.fetchImpl, now: () => NOW })],
    then: ["the dashboard gets an actionable typed state", (result) => {
      expect(result.error).toBe("consumer_tier_moved_to_antigravity");
    }],
  });
});
