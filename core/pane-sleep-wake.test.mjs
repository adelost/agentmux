import { expect, feature, unit } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaneSleepWakeLifecycle } from "./pane-sleep-wake.mjs";
import { readPaneSleepState, writePaneSleepState } from "./pane-sleep.mjs";
import { claudeProjectDir } from "./claude-paths.mjs";

const SESSION = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-07-20T12:00:00Z");

function fixture({ manifestSession = SESSION } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-sleep-wake-"));
  const paneDir = join(root, "workspace", ".agents", "3");
  const homeDir = join(root, "home");
  const projectDir = claudeProjectDir(paneDir, homeDir);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION}.jsonl`), "\n");
  const stateRoot = join(root, "state");
  writePaneSleepState({
    version: 1,
    agentName: "lsrc",
    pane: 3,
    status: "asleep",
    stage: "asleep",
    sleepGeneration: 7,
    sessionId: manifestSession,
  }, { rootDir: stateRoot });
  const previousHome = process.env.HOME;
  process.env.HOME = homeDir;
  const lifecycle = createPaneSleepWakeLifecycle({
    resolvePane: () => ({ paneDir, engine: "claude" }),
    stateRoot,
    now: () => NOW,
  });
  return {
    root,
    stateRoot,
    lifecycle,
    restore: () => {
      process.env.HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

feature("restart-safe exact-session wake lifecycle", () => {
  unit("prepare persists wake_pending before the process start", {
    given: ["an exact asleep session", () => fixture()],
    when: ["preparing wake", async (ctx) => ({
      ...ctx,
      token: await ctx.lifecycle.prepare({ agentName: "lsrc", pane: 3 }),
    })],
    then: ["the token and durable state bind generation seven", (ctx) => {
      expect(ctx.token).toMatchObject({
        ok: true,
        tracked: true,
        sessionId: SESSION,
        sleepGeneration: 7,
      });
      expect(readPaneSleepState("lsrc", 3, { rootDir: ctx.stateRoot })).toMatchObject({
        status: "wake_pending",
        sleepGeneration: 7,
      });
      ctx.restore();
    }],
  });

  unit("restart at wake_pending completes once without changing generation", {
    given: ["a prepared wake", async () => {
      const ctx = fixture();
      const token = await ctx.lifecycle.prepare({ agentName: "lsrc", pane: 3 });
      return { ...ctx, token };
    }],
    when: ["a replacement broker prepares again and completes", async (ctx) => {
      const replay = await ctx.lifecycle.prepare({ agentName: "lsrc", pane: 3 });
      const completed = await ctx.lifecycle.complete({
        agentName: "lsrc",
        pane: 3,
        token: replay,
        processState: { running: true },
      });
      return { ...ctx, replay, completed };
    }],
    then: ["state is awake with the original generation", (ctx) => {
      expect(ctx.replay.sleepGeneration).toBe(7);
      expect(ctx.completed).toEqual({ ok: true, tracked: true });
      expect(readPaneSleepState("lsrc", 3, { rootDir: ctx.stateRoot })).toMatchObject({
        status: "awake",
        sleepGeneration: 7,
      });
      ctx.restore();
    }],
  });

  unit("a wrong session blocks before any start can be claimed", {
    given: ["a manifest that does not match disk", () => fixture({ manifestSession: "wrong" })],
    when: ["preparing wake", async (ctx) => ({
      ...ctx,
      token: await ctx.lifecycle.prepare({ agentName: "lsrc", pane: 3 }),
    })],
    then: ["the mismatch is refused and made durable", (ctx) => {
      expect(ctx.token).toEqual({ ok: false, reason: "sleep-session-mismatch" });
      expect(readPaneSleepState("lsrc", 3, { rootDir: ctx.stateRoot })).toMatchObject({
        status: "blocked",
        blockedReason: "sleep-session-mismatch",
      });
      ctx.restore();
    }],
  });
});
