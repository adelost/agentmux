import { expect, feature, unit } from "bdd-vitest";
import { vi } from "vitest";
import { rotateClaudeFleet } from "./account-rotation.mjs";
import {
  beginRuntimeProfileTransition,
  selectedRuntimeProfile,
} from "../core/runtime-account-profiles.mjs";

const catalog = [
  { provider: "claude", id: "1", key: "claude:1", home: "/profiles/one" },
  { provider: "claude", id: "2", key: "claude:2", home: "/profiles/two" },
];

function fixture({ busy = false, restart = async () => ({ ok: true }) } = {}) {
  const values = {};
  const state = {
    get: (key, fallback) => values[key] ?? fallback,
    set: (key, value) => { values[key] = value; return value; },
  };
  const releases = [];
  const output = [];
  const compact = vi.fn(async () => ({
    ok: true,
    sessionId: "11111111-1111-4111-8111-111111111111",
  }));
  const agents = [{
    name: "lsrc",
    dir: "/work",
    panes: [
      { cmd: "claude --continue", accountProfile: 1 },
      { cmd: "claude --continue", accountProfile: 1 },
      { cmd: "codex --yolo" },
    ],
  }];
  const ctx = {
    state,
    deliveryQueue: {
      list: () => [],
      acquireSessionLease: () => ({ release: () => releases.push("released") }),
    },
    agent: {
      paneProcessState: async (_name, pane) => pane === 0
        ? { command: "claude", running: true, shell: false, dead: false }
        : { command: "bash", running: false, shell: true, dead: false },
      isBusy: async () => busy,
      promptTransportState: async () => ({ state: "empty-idle", busy }),
      restartClaudeAccount: restart,
    },
  };
  const deps = {
    agents,
    catalog,
    authenticated: () => true,
    prepare: () => {},
    compact,
    latestIdentity: () => ({
      sessionId: "11111111-1111-4111-8111-111111111111",
    }),
    output: (line) => output.push(line),
    setExitCode: () => {},
  };
  return { ctx, deps, state, agents, compact, output, releases };
}

feature("Claude fleet account rotation", () => {
  unit("compacts and restarts only the running pane while selecting sleepers", {
    given: ["one idle running pane and one sleeping pane", () => fixture()],
    when: ["rotating to profile 2", (ctx) =>
      rotateClaudeFleet(ctx.ctx, "2", {}, ctx.deps)],
    then: ["both selections change but only live work is compacted", (result, ctx) => {
      expect(result.status).toBe("RECOVERED");
      expect(ctx.compact).toHaveBeenCalledTimes(1);
      expect(result.rows.map((row) => row.status)).toEqual([
        "switched",
        "selected-for-next-wake",
      ]);
      for (const pane of [0, 1]) {
        expect(selectedRuntimeProfile({
          state: ctx.state,
          agentName: "lsrc",
          pane,
          paneConfig: ctx.agents[0].panes[pane],
          provider: "claude",
          catalog,
        }).id).toBe("2");
      }
      expect(ctx.releases).toEqual(["released"]);
    }],
  });

  unit("an active pane blocks before compact or profile writes", {
    given: ["a pane with an active turn", () => fixture({ busy: true })],
    when: ["requesting rotation", (ctx) =>
      rotateClaudeFleet(ctx.ctx, "2", {}, ctx.deps)],
    then: ["the fleet stays untouched", (result, ctx) => {
      expect(result.status).toBe("BLOCKED");
      expect(result.reason).toBe("preflight-failed");
      expect(ctx.compact).not.toHaveBeenCalled();
      expect(ctx.state.get("account_profile_by_pane_v1", {})).toEqual({});
    }],
  });

  unit("dry-run performs no compact or state write", {
    given: ["an eligible fleet", () => fixture()],
    when: ["preflighting only", (ctx) =>
      rotateClaudeFleet(ctx.ctx, "2", { dry: true }, ctx.deps)],
    then: ["the result describes both actions without performing them", (result, ctx) => {
      expect(result.status).toBe("DRY-RUN");
      expect(ctx.compact).not.toHaveBeenCalled();
      expect(ctx.state.get("account_profile_by_pane_v1", {})).toEqual({});
      expect(result.rows.map((row) => row.status)).toEqual([
        "would-running",
        "would-dormant",
      ]);
    }],
  });

  unit("missing target login blocks before fleet locks or pane reads", {
    given: ["an unauthenticated target profile", () => {
      const context = fixture();
      context.deps.authenticated = () => false;
      context.ctx.deliveryQueue.acquireSessionLease = vi.fn();
      context.ctx.agent.paneProcessState = vi.fn();
      return context;
    }],
    when: ["requesting rotation", (ctx) =>
      rotateClaudeFleet(ctx.ctx, "2", {}, ctx.deps)],
    then: ["no runtime boundary is touched", (result, ctx) => {
      expect(result).toMatchObject({ status: "BLOCKED", reason: "target-login-required" });
      expect(ctx.ctx.deliveryQueue.acquireSessionLease).not.toHaveBeenCalled();
      expect(ctx.ctx.agent.paneProcessState).not.toHaveBeenCalled();
    }],
  });

  unit("a failed target restart restores the previous profile and exact session", {
    given: ["a target restart that fails once", () => {
      const calls = [];
      const context = fixture({
        restart: async (_name, _pane, launch) => {
          calls.push(launch);
          if (launch.profile.id === "2") throw new Error("target-start-failed");
          return { ok: true };
        },
      });
      context.calls = calls;
      return context;
    }],
    when: ["rotating", (ctx) => rotateClaudeFleet(ctx.ctx, "2", {}, ctx.deps)],
    then: ["the live pane rolls back while the sleeping pane keeps the requested next profile", (result, ctx) => {
      expect(result.status).toBe("PARTIAL");
      expect(result.rows[0].status).toBe("rolled-back");
      expect(ctx.calls.map((call) => call.profile.id)).toEqual(["2", "1"]);
      expect(selectedRuntimeProfile({
        state: ctx.state,
        agentName: "lsrc",
        pane: 0,
        paneConfig: ctx.agents[0].panes[0],
        provider: "claude",
        catalog,
      }).id).toBe("1");
      expect(selectedRuntimeProfile({
        state: ctx.state,
        agentName: "lsrc",
        pane: 1,
        paneConfig: ctx.agents[0].panes[1],
        provider: "claude",
        catalog,
      }).id).toBe("2");
    }],
  });

  unit("an interrupted post-compact restart resumes without compacting again", {
    given: ["a durable restart intent whose pane is now a shell", () => {
      const context = fixture();
      beginRuntimeProfileTransition(context.state, {
        agentName: "lsrc",
        pane: 0,
        provider: "claude",
        previousProfileId: "1",
        targetProfileId: "2",
        sessionId: "11111111-1111-4111-8111-111111111111",
      });
      context.ctx.agent.paneProcessState = async () => ({
        command: "bash", running: false, shell: true, dead: false,
      });
      return context;
    }],
    when: ["the same rotation is retried", (ctx) =>
      rotateClaudeFleet(ctx.ctx, "2", {}, ctx.deps)],
    then: ["the exact restart intent completes without a second compact", (result, ctx) => {
      expect(result.status).toBe("RECOVERED");
      expect(ctx.compact).not.toHaveBeenCalled();
      expect(result.rows[0].status).toBe("switched");
      expect(ctx.state.get("account_profile_pending_by_pane_v1", {})).toEqual({});
    }],
  });
});
