import { vi } from "vitest";
import { feature, component, expect, unit } from "bdd-vitest";
import {
  createLinkTargetModels,
  qualifyLinkPaneModel,
  observeLinkTargetModels,
  targetsWithModels,
} from "./link-target-models.mjs";

const observed = (sessionId, model = "gpt-5.6-sol") => ({
  model,
  effort: "xhigh",
  sessionId,
  observedAt: "2026-09-20T08:00:00.000Z",
});

feature("Link target model truth", () => {
  unit("an observation is current only for the running pane's exact session", {
    when: ["the current session and the observed session are compared", () => [
      qualifyLinkPaneModel({
        running: true,
        currentSessionId: "session-two",
        observed: observed("session-two"),
        configured: { model: "gpt-6-astra", effort: "max" },
      }),
      qualifyLinkPaneModel({
        running: true,
        currentSessionId: "session-two",
        observed: observed("session-one"),
        configured: { model: "gpt-6-astra", effort: "max" },
      }),
    ]],
    then: ["the old model becomes stale instead of following the new session", ([current, changed]) => {
      expect(current).toEqual({
        status: "current",
        observed: { model: "gpt-5.6-sol", effort: "xhigh" },
        configured: { model: "gpt-6-astra", effort: "max" },
      });
      expect(changed).toEqual({
        status: "stale",
        observed: { model: "gpt-5.6-sol", effort: "xhigh" },
        configured: { model: "gpt-6-astra", effort: "max" },
      });
    }],
  });

  unit("missing current evidence stays unknown while prior evidence stays stale", {
    when: ["a new pane has either a prior reading or none", () => [
      qualifyLinkPaneModel({
        running: true,
        currentSessionId: "session-two",
        observed: null,
        previousObserved: { model: "claude-fable-5", effort: null },
        configured: { model: "claude-opus-4-8", effort: null },
      }),
      qualifyLinkPaneModel({
        running: true,
        currentSessionId: "session-two",
        observed: null,
        previousObserved: null,
        configured: { model: "claude-opus-4-8", effort: null },
      }),
    ]],
    then: ["configured intent never replaces observed truth", ([stale, unknown]) => {
      expect(stale.status).toBe("stale");
      expect(stale.observed.model).toBe("claude-fable-5");
      expect(unknown).toEqual({
        status: "unknown",
        observed: null,
        configured: { model: "claude-opus-4-8", effort: null },
      });
    }],
  });

  component("target observation reads status without running a model or waking a pane", {
    given: ["one mapped pane and read-only process/model adapters", () => {
      const agent = {
        paneProcessState: vi.fn(async () => ({
          running: true, command: "node", dead: false, shell: false,
        })),
        sendOnly: vi.fn(),
        ensureReady: vi.fn(),
      };
      const inspect = vi.fn(async () => ({
        modelView: {
          running: true,
          currentSessionId: "session-two",
          observed: observed("session-two"),
          configured: { model: "gpt-6-astra", effort: "max", source: "config" },
        },
      }));
      return { agent, inspect };
    }],
    when: ["Link reads the pane model", ({ agent, inspect }) => observeLinkTargetModels({
      targets: [{ id: "lsrc:3", label: "L-source 3", agent: "lsrc", pane: 3 }],
      agents: [{ name: "lsrc", dir: "/workspace", panes: [{}, {}, {}, { cmd: "codex" }] }],
      agent,
      state: { get: () => ({}) },
      inspect,
    }).then((models) => ({ agent, inspect, models }))],
    then: ["only read adapters ran and the target got current evidence", ({ agent, inspect, models }) => {
      expect(agent.paneProcessState).toHaveBeenCalledWith("lsrc", 3);
      expect(inspect).toHaveBeenCalledTimes(1);
      expect(agent.sendOnly).not.toHaveBeenCalled();
      expect(agent.ensureReady).not.toHaveBeenCalled();
      expect(models.get("lsrc:3")?.status).toBe("current");
    }],
  });

  component("an unchanged pane is not inspected again", {
    given: ["one mapped pane, a pane listing and a journal stamp the test moves", () => {
      const world = { pid: 4101, journal: "j1" };
      const tmux = { listAllPanes: vi.fn(async () => new Map([
        ["lsrc:3", { index: 3, id: "%9", dead: false, command: "node", path: "/w", pid: world.pid }],
      ])) };
      const agent = { paneProcessState: vi.fn() };
      const inspect = vi.fn(async () => ({
        modelView: { running: true, currentSessionId: "s2", observed: observed("s2"), configured: null },
      }));
      const read = createLinkTargetModels({
        agents: () => [{ name: "lsrc", dir: "/workspace", panes: [{}, {}, {}, { cmd: "claude" }] }],
        agent, state: { get: () => ({}) }, tmux, inspect, journalStamp: () => world.journal,
      });
      return { world, tmux, agent, inspect, read };
    }],
    when: ["Link reads four cycles: unchanged, unchanged, journal moved, pane restarted", async ({ world, tmux, agent, inspect, read }) => {
      const targets = [{ id: "lsrc:3", agent: "lsrc", pane: 3 }];
      const counts = [];
      await read(targets); counts.push(inspect.mock.calls.length);
      await read(targets); counts.push(inspect.mock.calls.length);
      world.journal = "j2"; await read(targets); counts.push(inspect.mock.calls.length);
      world.pid = 4999; const models = await read(targets); counts.push(inspect.mock.calls.length);
      return { counts, listings: tmux.listAllPanes.mock.calls.length, perPane: agent.paneProcessState.mock.calls.length, models };
    }],
    then: ["the unchanged cycle reused the reading, each change read it again, no per-pane questions", ({ counts, listings, perPane, models }) => {
      expect(counts).toEqual([1, 1, 2, 3]);
      expect(listings).toBe(4);
      expect(perPane).toBe(0);
      expect(models.get("lsrc:3")?.status).toBe("current");
    }],
  });

  component("targets without pane model evidence stay model-free", {
    given: ["one pane target and one Windows target", () => ({
      targets: [{ id: "lsrc:3" }, { id: "windows" }],
      models: new Map([["lsrc:3", {
        status: "unknown",
        observed: null,
        configured: { model: "claude-sonnet", effort: null },
      }]]),
    })],
    when: ["the model projection is applied", ({ targets, models }) => (
      targetsWithModels(targets, models)
    )],
    then: ["only the evidenced pane gains model status", (targets) => {
      expect(targets).toEqual([
        {
          id: "lsrc:3",
          model: {
            status: "unknown",
            observed: null,
            configured: { model: "claude-sonnet", effort: null },
          },
        },
        { id: "windows" },
      ]);
    }],
  });
});
