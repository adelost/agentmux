import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { feature, component, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import {
  CODEX_APP_SERVER_SOURCE,
  normalizeCodexAppServerQuota,
  readCodexAccountQuota,
} from "./codex-account-quota.mjs";

const PROFILE = { id: "2", key: "codex:2", label: "Second", source: "isolated", home: "/profiles/2" };
const ACCOUNT = { account: { type: "chatgpt", email: "two@example.com", planType: "pro" } };
const LIMITS = {
  rateLimits: { limitId: "codex", planType: "pro",
    primary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_800_000_000 } },
  rateLimitsByLimitId: {
    codex: { limitId: "codex", planType: "pro",
      primary: { usedPercent: 35, windowDurationMins: 10_080, resetsAt: 1_800_000_000 } },
  },
};

feature("official Codex account quota", () => {
  unit("normalizes identity, weekly quota and provider observation", {
    when: ["mapping an app-server response", () =>
      normalizeCodexAppServerQuota(PROFILE, ACCOUNT, LIMITS, "2026-07-27T01:00:00.000Z")],
    then: ["the account remains profile-scoped", (result) => {
      expect(result).toMatchObject({
        ok: true,
        profile: { key: "codex:2" },
        account: { email: "two@example.com", plan: "pro" },
        observation: { source: CODEX_APP_SERVER_SOURCE, usedPercent: 35, remainingPercent: 65 },
      });
    }],
  });

  component("reads account limits without starting a model turn", {
    given: ["a protocol-faithful fake app-server", () => {
      const stdout = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        stdout,
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      const sent = [];
      child.stdin = new Writable({
        write(chunk, _encoding, done) {
          const message = JSON.parse(String(chunk));
          sent.push(message);
          if (message.method === "initialize") {
            queueMicrotask(() => stdout.write(`${JSON.stringify({ id: 1, result: { userAgent: "codex" } })}\n`));
          }
          if (message.method === "account/read") {
            queueMicrotask(() => stdout.write(`${JSON.stringify({ id: 2, result: ACCOUNT })}\n`));
          }
          if (message.method === "account/rateLimits/read") {
            queueMicrotask(() => stdout.write(`${JSON.stringify({ id: 3, result: LIMITS })}\n`));
          }
          done();
        },
      });
      return { child, sent, spawnImpl: vi.fn(() => child) };
    }],
    when: ["reading the second profile", ({ spawnImpl }) =>
      readCodexAccountQuota(PROFILE, { spawnImpl, now: () => Date.parse("2026-07-27T01:00:00Z") })],
    then: ["only initialization, account and rate-limit methods were sent", (result, ctx) => {
      expect(result.ok).toBe(true);
      expect(ctx.spawnImpl.mock.calls[0][2].env.CODEX_HOME).toBe("/profiles/2");
      expect(ctx.sent.map((message) => message.method)).toEqual([
        "initialize", "initialized", "account/read", "account/rateLimits/read",
      ]);
      expect(ctx.sent.some((message) => String(message.method).startsWith("thread/"))).toBe(false);
    }],
  });
});
