import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import {
  claimSuggestionsPoller,
  runSuggestionsForeground,
  SUGGESTIONS_COMPONENTS,
} from "./suggestions.mjs";

describe("visible Suggestions poller", () => {
  it("owns one terminal process and safely reclaims a stale crash lock", () => {
    const parent = mkdtempSync(join(tmpdir(), "amux-suggest-owner-"));
    const root = join(parent, "lock");
    try {
      const release = claimSuggestionsPoller({
        root, pid: 100, now: () => 1_000, isAlive: (pid) => pid === 100,
      });
      expect(() => claimSuggestionsPoller({
        root, pid: 200, now: () => 2_000, isAlive: (pid) => pid === 100,
      })).toThrow(/already runs as pid 100/u);
      const releaseAfterStop = claimSuggestionsPoller({
        root, pid: 200, now: () => 2_000, isAlive: () => false,
      });
      release();
      releaseAfterStop();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("removes both hidden crons and keeps retryable component failures visible", async () => {
    const controller = new AbortController();
    const removeLegacyCrons = vi.fn(async () => {});
    const runChild = vi.fn(async (_command, args) => {
      if (args[0].includes("watchdog")) controller.abort();
      return { code: args[0].includes("watchdog") ? 1 : 0, signal: null };
    });
    const release = vi.fn();
    const logger = { log: vi.fn() };

    const result = await runSuggestionsForeground({
      bridgeDir: "/release",
      signal: controller.signal,
      intervalMs: 1_000,
      runChild,
      removeLegacyCrons,
      claim: () => release,
      logger,
      now: () => 1_000,
    });

    expect(removeLegacyCrons).toHaveBeenCalledOnce();
    expect(runChild.mock.calls.map((call) => call[1][0]))
      .toEqual(SUGGESTIONS_COMPONENTS.map((component) =>
        `/release/bin/${component.wrapper}`));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(
      "comments=ok outbox=retry(exit 1)"));
    expect(result.exitCode).toBe(0);
    expect(release).toHaveBeenCalledOnce();
  });

  it("supports a non-mutating diagnostic run without removing cron ownership", async () => {
    const removeLegacyCrons = vi.fn();
    const runChild = vi.fn(async () => ({ code: 0, signal: null }));

    const result = await runSuggestionsForeground({
      bridgeDir: "/release",
      once: true,
      runChild,
      removeLegacyCrons,
      claim: () => () => {},
      logger: { log: vi.fn() },
    });

    expect(removeLegacyCrons).not.toHaveBeenCalled();
    expect(runChild).toHaveBeenCalledTimes(2);
    expect(result.exitCode).toBe(0);
  });
});
