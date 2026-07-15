import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature, unit } from "bdd-vitest";
import { vi } from "vitest";
import {
  SuggestionsCircuitOpenError,
  SuggestionsHttpError,
  createSuggestionsHttpClient,
  cronStartJitterMs,
  readSuggestionsCircuitState,
} from "./suggestions-http.mjs";

const URL = "https://suggest.v1d.io/api/config?project=source";
const TOKEN = "r".repeat(40);
const json = (body, status = 200) => Response.json(body, { status });
const root = () => mkdtempSync(join(tmpdir(), "amux-suggestions-http-"));
const client = ({ statePath, fetchImpl, now, source = "comment-bridge", sleep } = {}) =>
  createSuggestionsHttpClient({
    source,
    statePath,
    fetchImpl,
    now,
    sleep: sleep ?? (async () => {}),
    startJitterMaxMs: 0,
    jitterUnit: () => 0,
  });
const request = (http) => http.requestJson(URL, {
  token: TOKEN,
  timeoutMs: 1_000,
  maxBytes: 64 * 1024,
});

feature("Suggestions shared HTTP load circuit", () => {
  component("a non-retryable 5xx survives process restart and suppresses the next cron", {
    given: ["one shared state path and a board returning retryable false", () => {
      const directory = root();
      let nowMs = Date.parse("2026-07-15T23:59:50Z");
      const fetchImpl = vi.fn(async () => json({
        error: "durable-object-unavailable",
        reason: "durable-object-remote-error",
        retryable: false,
      }, 500));
      return { directory, statePath: join(directory, "circuit.json"), fetchImpl,
        now: () => nowMs, setNow: (value) => { nowMs = value; } };
    }],
    when: ["a second client instance polls immediately after the first failure", async (ctx) => {
      const first = await request(client(ctx)).catch((error) => error);
      const restarted = client({ ...ctx, source: "watchdog-outbox" });
      const second = await request(restarted).catch((error) => error);
      return { first, second, calls: ctx.fetchImpl.mock.calls.length,
        state: readSuggestionsCircuitState(ctx.statePath) };
    }],
    then: ["one network call is made and the durable circuit reports its retry boundary", (result) => {
      expect(result.first).toBeInstanceOf(SuggestionsHttpError);
      expect(result.first).toMatchObject({ status: 500, retryable: false });
      expect(result.second).toBeInstanceOf(SuggestionsCircuitOpenError);
      expect(result.calls).toBe(1);
      expect(result.state).toMatchObject({ consecutiveFailures: 1,
        lastFailure: { status: 500, retryable: false } });
      expect(result.state.blockedUntil).toBeGreaterThan(result.state.lastFailure.at);
    }],
    cleanup: (ctx) => rmSync(ctx.directory, { recursive: true, force: true }),
  });

  component("only one half-open probe may leave the host after backoff", {
    given: ["an expired circuit and two independently restarted cron clients", async () => {
      const directory = root();
      const statePath = join(directory, "circuit.json");
      let nowMs = Date.parse("2026-07-15T12:00:00Z");
      const failed = vi.fn(async () => json({ error: "down", retryable: false }, 503));
      await request(client({ statePath, fetchImpl: failed, now: () => nowMs })).catch(() => {});
      nowMs = readSuggestionsCircuitState(statePath).blockedUntil;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const probingFetch = vi.fn(async () => {
        await gate;
        return json({ ok: true });
      });
      return { directory, statePath, probingFetch, now: () => nowMs, release };
    }],
    when: ["both crons race at the retry boundary", async (ctx) => {
      const first = request(client({ ...ctx, fetchImpl: ctx.probingFetch,
        source: "comment-bridge" }));
      await Promise.resolve();
      const second = await request(client({ ...ctx, fetchImpl: ctx.probingFetch,
        source: "watchdog-outbox" }))
        .catch((error) => error);
      ctx.release();
      const response = await first;
      return { response, second, calls: ctx.probingFetch.mock.calls.length };
    }],
    then: ["the single probe succeeds while the contender remains locally blocked", (result) => {
      expect(result.response).toEqual({ ok: true });
      expect(result.second).toBeInstanceOf(SuggestionsCircuitOpenError);
      expect(result.calls).toBe(1);
    }],
    cleanup: (ctx) => rmSync(ctx.directory, { recursive: true, force: true }),
  });

  component("repeated non-retryable probes use bounded exponential backoff", {
    given: ["one persistent circuit and a deterministic clock", () => {
      const directory = root();
      let nowMs = Date.parse("2026-07-15T12:00:00Z");
      return { directory, statePath: join(directory, "circuit.json"),
        now: () => nowMs, advanceTo: (value) => { nowMs = value; },
        fetchImpl: vi.fn(async () => json({ error: "down", retryable: false }, 500)) };
    }],
    when: ["two allowed probes both fail", async (ctx) => {
      await request(client(ctx)).catch(() => {});
      const first = readSuggestionsCircuitState(ctx.statePath);
      ctx.advanceTo(first.blockedUntil);
      await request(client({ ...ctx, source: "watchdog-outbox" })).catch(() => {});
      const second = readSuggestionsCircuitState(ctx.statePath);
      return { firstDelay: first.blockedUntil - first.lastFailure.at,
        secondDelay: second.blockedUntil - second.lastFailure.at,
        failures: second.consecutiveFailures };
    }],
    then: ["the second delay doubles while remaining below the two-hour cap", (result) => {
      expect(result).toEqual({ firstDelay: 15 * 60_000, secondDelay: 30 * 60_000,
        failures: 2 });
    }],
    cleanup: (ctx) => rmSync(ctx.directory, { recursive: true, force: true }),
  });

  component("authentication failures stay visible and never poison board availability", {
    given: ["a 401 followed by a healthy response", () => {
      const directory = root();
      const fetchImpl = vi.fn()
        .mockResolvedValueOnce(json({ error: "agent-token-invalid" }, 401))
        .mockResolvedValueOnce(json({ ok: true }));
      return { directory, statePath: join(directory, "circuit.json"), fetchImpl,
        now: () => Date.parse("2026-07-15T12:00:00Z") };
    }],
    when: ["a restarted caller tries after the authentication error", async (ctx) => {
      const first = await request(client(ctx)).catch((error) => error);
      const second = await request(client({ ...ctx, source: "quota-push" }));
      return { first, second, calls: ctx.fetchImpl.mock.calls.length };
    }],
    then: ["both requests reach the host so credentials can be repaired explicitly", (result) => {
      expect(result.first).toMatchObject({ status: 401 });
      expect(result.second).toEqual({ ok: true });
      expect(result.calls).toBe(2);
    }],
    cleanup: (ctx) => rmSync(ctx.directory, { recursive: true, force: true }),
  });

  component("circuit state is private and malformed state fails closed", {
    given: ["a newly tripped circuit", () => {
      const directory = root();
      const statePath = join(directory, "circuit.json");
      return { directory, statePath, now: () => Date.parse("2026-07-15T12:00:00Z"),
        fetchImpl: vi.fn(async () => json({ error: "down", retryable: false }, 500)) };
    }],
    when: ["the state is persisted and then corrupted", async (ctx) => {
      await request(client(ctx)).catch(() => {});
      const mode = statSync(ctx.statePath).mode & 0o777;
      const before = JSON.parse(readFileSync(ctx.statePath, "utf8"));
      const { writeFileSync } = await import("node:fs");
      writeFileSync(ctx.statePath, "not-json\n", { mode: 0o600 });
      const after = await request(client({ ...ctx, fetchImpl: vi.fn() })).catch((error) => error);
      return { mode, before, after };
    }],
    then: ["the ledger is mode 0600 and corruption cannot silently restore polling", (result) => {
      expect(result.mode).toBe(0o600);
      expect(result.before.schemaVersion).toBe(1);
      expect(result.after).toBeInstanceOf(SuggestionsCircuitOpenError);
      expect(result.after.reason).toBe("circuit-state-invalid");
    }],
    cleanup: (ctx) => rmSync(ctx.directory, { recursive: true, force: true }),
  });
});

feature("Suggestions cron reset jitter", () => {
  unit("the three board callers receive stable distinct offsets after UTC reset", {
    given: ["the first minute of one UTC day", () => Date.parse("2026-07-16T00:00:00Z")],
    when: ["computing the shared deterministic start policy", (nowMs) => [
      "comment-bridge", "watchdog-outbox", "quota-push",
    ].map((source) => cronStartJitterMs(source, nowMs, 20_000))],
    then: ["all starts are spread inside the bounded jitter window", (offsets) => {
      expect(new Set(offsets).size).toBe(3);
      expect(offsets.every((offset) => offset >= 1_000 && offset <= 20_000)).toBe(true);
    }],
  });
});
