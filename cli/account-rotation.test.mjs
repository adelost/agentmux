import { expect, feature, unit } from "bdd-vitest";
import { afterEach, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateClaudeFleet } from "./account-rotation.mjs";
import {
  beginRuntimeProfileTransition,
  selectedRuntimeProfile,
} from "../core/runtime-account-profiles.mjs";

const catalog = [
  { provider: "claude", id: "1", key: "claude:1", home: "/profiles/one" },
  { provider: "claude", id: "2", key: "claude:2", home: "/profiles/two" },
];
const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture({ busy = false, restart = async () => ({ ok: true }) } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-rotation-"));
  roots.push(root);
  const cwd = join(root, ".agents/0"), sessionId = "11111111-1111-4111-8111-111111111111";
  mkdirSync(cwd, { recursive: true });
  const path = join(root, `${sessionId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "user", sessionId, cwd })}\n`);
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
    prepare: vi.fn(),
    access: vi.fn(async () => ({ ok: true })),
    compact,
    latestIdentity: () => ({ sessionId, cwd, path }),
    output: (line) => output.push(line),
    setExitCode: () => {},
  };
  return { ctx, deps, state, agents, compact, output, releases, path };
}

feature("Claude fleet account rotation", () => {
  unit("a locked project does not prevent another empty sleeping project from rotating", {
    given: ["Skydive owns its delivery lease while lsrc is an empty shell", () => {
      const fx = fixture();
      fx.deps.agents = [
        { name: "skydive", dir: "/work/skydive", panes: [{ cmd: "claude --continue", accountProfile: 1 }] },
        { name: "lsrc", dir: "/work/lsrc", panes: [{ cmd: "claude --continue", accountProfile: 1 }] },
      ];
      fx.ctx.deliveryQueue.acquireSessionLease = (name) => name === "skydive"
        ? null : { release: () => fx.releases.push(name) };
      fx.ctx.agent.paneProcessState = async () => ({ command: "bash", running: false, shell: true, dead: false });
      fx.ctx.agent.restartClaudeAccount = vi.fn();
      return fx;
    }],
    when: ["rotating to the accessible account", fx => rotateClaudeFleet(fx.ctx, "2", {}, fx.deps)],
    then: ["only lsrc changes and the blocked lease remains untouched", (result, fx) => {
      expect(result.status).toBe("PARTIAL");
      expect(result.rows.map((row) => [row.key, row.status, row.reason])).toEqual(expect.arrayContaining([
        ["skydive:0", "blocked", "delivery-lease-busy:skydive"],
        ["lsrc:0", "selected-for-next-wake", null],
      ]));
      expect(fx.state.get("account_profile_by_pane_v1", {})).toEqual({ "lsrc:0": "2" });
      expect(fx.ctx.agent.restartClaudeAccount).not.toHaveBeenCalled();
      expect(fx.releases).toEqual(["lsrc"]);
    }],
  });

  unit("a submitted job blocks its project without blocking a separate idle project", {
    given: ["one Skydive delivery is submitted and lsrc is an empty shell", () => {
      const fx = fixture();
      fx.deps.agents = [
        { name: "skydive", dir: "/work/skydive", panes: [
          { cmd: "claude --continue", accountProfile: 1 },
          { cmd: "claude --continue", accountProfile: 1 },
        ] },
        { name: "lsrc", dir: "/work/lsrc", panes: [{ cmd: "claude --continue", accountProfile: 1 }] },
      ];
      fx.ctx.deliveryQueue.list = (name, pane) => name === "skydive" && pane === 0
        ? [{ status: "submitted" }] : [];
      fx.ctx.deliveryQueue.acquireSessionLease = (name) => ({ release: () => fx.releases.push(name) });
      fx.ctx.agent.paneProcessState = async () => ({ command: "bash", running: false, shell: true, dead: false });
      fx.ctx.agent.restartClaudeAccount = vi.fn();
      return fx;
    }],
    when: ["rotating to the accessible account", fx => rotateClaudeFleet(fx.ctx, "2", {}, fx.deps)],
    then: ["the submitted project stays on its source profile", (result, fx) => {
      expect(result.status).toBe("PARTIAL");
      expect(result.rows.find((row) => row.key === "skydive:0")).toMatchObject({
        status: "blocked", reason: "live-or-unknown-delivery",
      });
      expect(result.rows.find((row) => row.key === "skydive:1")).toMatchObject({
        status: "blocked", reason: "project-preflight-failed:skydive:0",
      });
      expect(fx.state.get("account_profile_by_pane_v1", {})).toEqual({ "lsrc:0": "2" });
      expect(fx.ctx.agent.restartClaudeAccount).not.toHaveBeenCalled();
    }],
  });

  unit("a partial dry-run reports both projects without changing either", {
    given: ["a locked project and an empty sleeping project", () => {
      const fx = fixture();
      fx.deps.agents = [
        { name: "skydive", dir: "/work/skydive", panes: [{ cmd: "claude --continue", accountProfile: 1 }] },
        { name: "lsrc", dir: "/work/lsrc", panes: [{ cmd: "claude --continue", accountProfile: 1 }] },
      ];
      fx.ctx.deliveryQueue.acquireSessionLease = (name) => name === "skydive"
        ? null : { release: () => fx.releases.push(name) };
      fx.ctx.agent.paneProcessState = async () => ({ command: "bash", running: false, shell: true, dead: false });
      return fx;
    }],
    when: ["preflighting the target", fx => rotateClaudeFleet(fx.ctx, "2", { dry: true }, fx.deps)],
    then: ["partial status is explicit and no selection is written", (result, fx) => {
      expect(result.status).toBe("PARTIAL");
      expect(result.rows.find((row) => row.key === "lsrc:0").status).toBe("would-dormant");
      expect(fx.state.get("account_profile_by_pane_v1", {})).toEqual({});
      expect(fx.deps.prepare).not.toHaveBeenCalled();
    }],
  });

  unit("an already selected running pane is not restarted again", {
    given: ["the target profile is durably selected", () => {
      const fx = fixture();
      fx.state.set("account_profile_by_pane_v1", { "lsrc:0": "2" });
      fx.ctx.agent.restartClaudeAccount = vi.fn();
      return fx;
    }],
    when: ["retrying the same rotation", fx => rotateClaudeFleet(fx.ctx, "2", {}, fx.deps)],
    then: ["the live session is left intact", (result, fx) => {
      expect(result.status).toBe("RECOVERED");
      expect(result.rows[0].status).toBe("already-selected");
      expect(fx.ctx.agent.restartClaudeAccount).not.toHaveBeenCalled();
    }],
  });

  unit("restarts only the running pane without a source model turn while selecting sleepers", {
    given: ["one idle running pane and one sleeping pane", () => fixture()],
    when: ["rotating to profile 2", (ctx) =>
      rotateClaudeFleet(ctx.ctx, "2", {}, ctx.deps)],
    then: ["both selections change without any compaction", (result, ctx) => {
      expect(result.status).toBe("RECOVERED");
      expect(ctx.compact).not.toHaveBeenCalled();
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
      expect(ctx.deps.prepare).not.toHaveBeenCalled();
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
      expect(ctx.deps.prepare).not.toHaveBeenCalled();
      expect(ctx.state.get("account_profile_by_pane_v1", {})).toEqual({});
      expect(result.rows.map((row) => row.status)).toEqual([
        "would-running",
        "would-dormant",
      ]);
    }],
  });

  unit("source subscription exhaustion cannot deadlock rotation", {
    given: ["a source account on which every model call fails", () => {
      const fx = fixture();
      fx.deps.compact = vi.fn(async () => { throw new Error("source-quota-exhausted"); });
      return fx;
    }],
    when: ["switching to an accessible target", fx => rotateClaudeFleet(fx.ctx, "2", {}, fx.deps)],
    then: ["exact resume succeeds without calling the source model", (result, fx) => {
      expect(result.status).toBe("RECOVERED"); expect(fx.deps.compact).not.toHaveBeenCalled();
    }],
  });

  unit("provider-disabled target blocks before any process or profile mutation", {
    given: ["a target with credential files but no subscription access", () => {
      const fx = fixture(); fx.deps.access = async () => ({ ok: false, error: "http_403" });
      fx.ctx.agent.restartClaudeAccount = vi.fn(); return fx;
    }],
    when: ["requesting rotation", fx => rotateClaudeFleet(fx.ctx, "2", {}, fx.deps)],
    then: ["authentication failure stays explicit", (result, fx) => {
      expect(result.reason).toBe("target-access-unverified:http_403");
      expect(fx.deps.prepare).not.toHaveBeenCalled(); expect(fx.ctx.agent.restartClaudeAccount).not.toHaveBeenCalled();
    }],
  });

  unit("a journal append during preflight prevents that pane restart", {
    given: ["a new turn appearing after the first observation", () => {
      const fx = fixture(); fx.deps.prepare = () => appendFileSync(fx.path, '{"type":"user"}\n');
      fx.ctx.agent.restartClaudeAccount = vi.fn(); return fx;
    }],
    when: ["requesting rotation", fx => rotateClaudeFleet(fx.ctx, "2", {}, fx.deps)],
    then: ["the changed session is not killed", (result, fx) => {
      expect(result.status).toBe("BLOCKED"); expect(result.rows[0].reason).toBe("rotation-session-changed");
      expect(fx.ctx.agent.restartClaudeAccount).not.toHaveBeenCalled();
      expect(fx.state.get("account_profile_by_pane_v1", {})).toEqual({});
    }],
  });

  unit("incomplete journal tails never authorize a restart", {
    given: ["a torn final JSONL row", () => {
      const fx = fixture(); appendFileSync(fx.path, '{"type":'); fx.ctx.agent.restartClaudeAccount = vi.fn(); return fx;
    }],
    when: ["requesting rotation", fx => rotateClaudeFleet(fx.ctx, "2", {}, fx.deps)],
    then: ["the transcript is not treated as durable continuity", (result, fx) => {
      expect(result.rows[0].reason).toBe("rotation-journal-incomplete");
      expect(fx.ctx.agent.restartClaudeAccount).not.toHaveBeenCalled();
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
