import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import {
  claimSuggestionsPoller,
  configuredSuggestionsComponents,
  removeLegacySuggestionsCrons,
  runSuggestionsForeground,
  SUGGESTIONS_COMPONENTS,
} from "./suggestions.mjs";

describe("visible Suggestions poller", () => {
  const configured = () => configuredSuggestionsComponents({
    home: "/home/test", env: {}, exists: () => true,
  });

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

  it("removes every hidden cron and keeps retryable component failures visible", async () => {
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
      components: configured(),
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

  it("uninstalls every legacy Suggestions scheduler through its owning installer", async () => {
    const runChild = vi.fn(async () => ({ code: 0, signal: null }));

    await removeLegacySuggestionsCrons({ bridgeDir: "/release", runChild });

    expect(runChild.mock.calls.map((call) => call[1])).toEqual(
      SUGGESTIONS_COMPONENTS.map((component) => [
        `/release/bin/${component.installer}`, "uninstall",
      ]),
    );
  });

  it("keeps quota at fifteen minutes while minute inputs run every scheduler tick", async () => {
    const controller = new AbortController();
    let clock = 0;
    const runChild = vi.fn(async (_command, args) => {
      if (args[0].endsWith("/quota.sh") && clock === 15_000) controller.abort();
      return { code: 0, signal: null };
    });
    const components = [
      { name: "minute", wrapper: "minute.sh", intervalMs: 1_000, args: [], enabled: true },
      { name: "quota", wrapper: "quota.sh", intervalMs: 15_000, args: [], enabled: true },
    ];

    await runSuggestionsForeground({
      bridgeDir: "/release",
      signal: controller.signal,
      intervalMs: 1_000,
      runChild,
      removeLegacyCrons: async () => {},
      claim: () => () => {},
      components,
      logger: { log: vi.fn() },
      now: () => clock,
      wait: async () => { clock += 1_000; },
    });

    const wrappers = runChild.mock.calls.map((call) => call[1][0]);
    expect(wrappers.filter((path) => path.endsWith("/minute.sh"))).toHaveLength(16);
    expect(wrappers.filter((path) => path.endsWith("/quota.sh"))).toHaveLength(2);
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
      components: configured(),
      logger: { log: vi.fn() },
    });

    expect(removeLegacyCrons).not.toHaveBeenCalled();
    expect(runChild).toHaveBeenCalledTimes(4);
    expect(result.exitCode).toBe(0);
  });
});
