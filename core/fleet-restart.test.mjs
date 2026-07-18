import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  FLEET_RESTART_RESULT_KEY,
  consumeFleetRestart,
  formatFleetRestartResult,
  queueFleetRestart,
  runPendingFleetRestart,
} from "./fleet-restart.mjs";

feature("durable fleet restart handoff", () => {
  unit("queue is atomic and consumed exactly once", {
    given: ["an isolated request path", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-fleet-request-"));
      return { root, path: join(root, "request.json") };
    }],
    when: ["queueing and consuming", ({ path }) => {
      queueFleetRestart({ source: "cli", requestedAt: "2026-07-12T13:00:00.000Z", path });
      const existed = existsSync(path);
      const first = consumeFleetRestart({ path });
      const second = consumeFleetRestart({ path });
      return { existed, first, second };
    }],
    then: ["one valid receipt survives and the file is gone", (result, { root, path }) => {
      expect(result.existed).toBe(true);
      expect(result.first).toEqual({ version: 1, source: "cli", requestedAt: "2026-07-12T13:00:00.000Z" });
      expect(result.second).toBeNull();
      expect(existsSync(path)).toBe(false);
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("the outside watchdog is an authorized fleet-restart source", {
    given: ["an isolated watchdog request", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-fleet-watchdog-"));
      return { root, path: join(root, "request.json") };
    }],
    when: ["the replacement bridge consumes it", ({ path }) => {
      queueFleetRestart({ source: "watchdog", requestedAt: "2026-07-18T18:00:00.000Z", path });
      return consumeFleetRestart({ path });
    }],
    then: ["the durable handoff preserves watchdog provenance", (request, { root }) => {
      expect(request).toEqual({
        version: 1, source: "watchdog", requestedAt: "2026-07-18T18:00:00.000Z",
      });
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("replacement bridge executes and persists a compact receipt", {
    given: ["a Discord request, agent and state", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-fleet-run-"));
      const path = join(root, "request.json");
      queueFleetRestart({ source: "discord", requestedAt: "2026-07-12T13:00:00.000Z", path });
      const stored = {};
      return {
        root,
        path,
        stored,
        state: { set: (key, value) => { stored[key] = value; } },
        agent: { restartFleet: async () => ({
          ok: true,
          configured: ["claw", "ai"],
          stopped: ["claw", "ai"],
          recreated: ["claw", "ai"],
          codingPanes: 6,
          failures: [],
        }) },
      };
    }],
    when: ["the replacement bridge starts", ({ agent, state, path }) =>
      runPendingFleetRestart({ agent, state, path, log: () => {} })],
    then: ["the fleet receipt is ready for startup notification", (receipt, { root, stored }) => {
      expect(receipt).toMatchObject({ ok: true, source: "discord", codingPanes: 6 });
      expect(stored[FLEET_RESTART_RESULT_KEY]).toEqual(receipt);
      expect(formatFleetRestartResult(receipt)).toBe("online · helreset klar: 2/2 tmux-sessioner, 6 agentpaneler");
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("partial failures are named without leaking error detail to Discord", {
    when: ["formatting a partial receipt", () => formatFleetRestartResult({
      ok: false,
      configured: ["claw", "ai"],
      recreated: ["claw"],
      codingPanes: 3,
      failures: [{ name: "ai", stage: "start", error: "private path and command" }],
    })],
    then: ["only agent and stage are shown", (text) => {
      expect(text).toContain("ai (start)");
      expect(text).not.toContain("private path");
    }],
  });

  unit("only interrupted exact sessions receive one durable continuation", {
    given: ["a restart receipt with one active Fable pane", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-fleet-continuation-"));
      const path = join(root, "request.json");
      queueFleetRestart({ source: "cli", requestedAt: "2026-07-18T14:00:00.000Z", path });
      const enqueued = [];
      return {
        root,
        path,
        enqueued,
        agent: { restartFleet: async () => ({
          ok: true,
          configured: ["claw"],
          stopped: ["claw"],
          recreated: ["claw"],
          codingPanes: 2,
          failures: [],
          resumeTargets: [{
            agentName: "claw", pane: 6, dialect: "claude",
            sessionId: "11111111-1111-4111-8111-111111111111",
          }],
        }) },
      };
    }],
    when: ["the replacement bridge queues recovery before its broker starts", (ctx) =>
      runPendingFleetRestart({
        agent: ctx.agent,
        path: ctx.path,
        log: () => {},
        enqueueContinuation: (request) => ctx.enqueued.push(request),
      })],
    then: ["the continuation is idempotent and bound to that pane session", (receipt, ctx) => {
      expect(ctx.enqueued).toHaveLength(1);
      expect(ctx.enqueued[0]).toMatchObject({
        agentName: "claw",
        pane: 6,
        source: "fleet-restart-recovery",
        metadata: { recoveredSessionId: "11111111-1111-4111-8111-111111111111" },
      });
      expect(ctx.enqueued[0].idempotencyKey).toContain("11111111-1111-4111-8111-111111111111");
      expect(ctx.enqueued[0].text).toContain("Fortsätt den avbrutna uppgiften");
      expect(formatFleetRestartResult(receipt)).toContain("1 avbrutna turns återköade");
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
});
