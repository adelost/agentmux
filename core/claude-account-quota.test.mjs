import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import {
  CLAUDE_TOKEN_URL,
  CLAUDE_USAGE_URL,
  normalizeClaudeUsage,
  readClaudeQuota,
} from "./claude-account-quota.mjs";

const NOW = Date.parse("2026-07-27T01:00:00Z");
const PROFILE = { provider: "claude", id: "2", key: "claude:2", label: "Windows Max",
  source: "windows", identityPath: "/not-present" };
const usage = { limits: [
  { kind: "session", percent: 5, resets_at: "2026-07-27T04:00:00Z" },
  { kind: "weekly_all", percent: 60, resets_at: "2026-07-29T07:00:00Z" },
] };

feature("Claude Code account quota", () => {
  unit("labels one normalized profile without persisting tokens in the result", {
    when: ["normalizing provider usage", () => normalizeClaudeUsage(
      usage, "2026-07-27T01:00:00Z", PROFILE, { subscriptionType: "max", accessToken: "secret" })],
    then: ["identity and plan remain metadata while the access token is absent", (result) => {
      expect(result).toMatchObject({
        ok: true, profile: { key: "claude:2" }, account: { plan: "max" },
        observation: { usedPercent: 60, remainingPercent: 40 },
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    }],
  });

  unit("refreshes an expired provider credential exactly once before reading usage", {
    given: ["an expired Claude Code profile", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-claude-profile-"));
      const credentialsPath = join(root, ".credentials.json");
      writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: {
        accessToken: "expired", refreshToken: "refresh", expiresAt: NOW - 1,
        subscriptionType: "max", scopes: ["user:profile"],
      } }));
      const fetchImpl = vi.fn(async (url, request) => {
        if (url === CLAUDE_TOKEN_URL) {
          expect(String(request.body)).toContain("grant_type=refresh_token");
          return { ok: true, json: async () => ({
            access_token: "fresh", refresh_token: "refresh-2", expires_in: 3600,
          }) };
        }
        expect(url).toBe(CLAUDE_USAGE_URL);
        expect(request.headers.Authorization).toBe("Bearer fresh");
        return { ok: true, json: async () => usage };
      });
      return { credentialsPath, fetchImpl };
    }],
    when: ["collecting the profile", ({ credentialsPath, fetchImpl }) =>
      readClaudeQuota({ profile: { ...PROFILE, credentialsPath }, credentialsPath,
        fetchImpl, now: () => NOW })],
    then: ["the refreshed credential stays in the provider file and quota succeeds", (result, ctx) => {
      expect(result.ok).toBe(true);
      expect(ctx.fetchImpl).toHaveBeenCalledTimes(2);
      const stored = JSON.parse(readFileSync(ctx.credentialsPath, "utf8")).claudeAiOauth;
      expect(stored.accessToken).toBe("fresh");
      expect(stored.refreshToken).toBe("refresh-2");
    }],
  });

  unit("invalid refresh is login-required and never probes usage", {
    given: ["an expired credential rejected by OAuth", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-claude-rejected-"));
      const credentialsPath = join(root, ".credentials.json");
      writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: {
        accessToken: "expired", refreshToken: "dead", expiresAt: NOW - 1,
      } }));
      return { credentialsPath, fetchImpl: vi.fn(async () => ({ ok: false, status: 400 })) };
    }],
    when: ["collecting", ({ credentialsPath, fetchImpl }) =>
      readClaudeQuota({ profile: { ...PROFILE, credentialsPath }, credentialsPath,
        fetchImpl, now: () => NOW })],
    then: ["the classified result asks for login after one request", (result, ctx) => {
      expect(result.error).toBe("login_required");
      expect(ctx.fetchImpl).toHaveBeenCalledTimes(1);
    }],
  });
});
