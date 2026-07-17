import { feature, component, unit, expect } from "bdd-vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureAgentHints, HINTS_END_MARKER, HINTS_VERSION } from "../agent.mjs";
import { readHeartbeat, writeHeartbeat } from "./heartbeat.mjs";
import { assessRunningBridgeHints, syncConfiguredAgentHints } from "./hints-sync.mjs";

function fleetFixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-hints-sync-"));
  const shared = join(root, "shared");
  const solo = join(root, "solo");
  mkdirSync(join(shared, ".agents"), { recursive: true });
  mkdirSync(solo, { recursive: true });
  writeFileSync(join(shared, ".agents", "CLAUDE.md"), [
    "<!-- amux-hints-version: old -->",
    "# stale generated block",
    HINTS_END_MARKER,
    "",
    "# Workspace rules",
    "KEEP_THIS_TAIL",
    "",
  ].join("\n"));
  writeFileSync(join(shared, ".agents", "AGENTS.md"), [
    "<!-- amux-hints-version: old -->",
    "# stale generated block",
    HINTS_END_MARKER,
    "",
    "STALE_NON_CANONICAL_TAIL",
    "",
  ].join("\n"));
  return {
    root,
    shared,
    solo,
    agents: [
      { name: "alpha", dir: shared },
      { name: "beta", dir: shared },
      { name: "gamma", dir: solo },
    ],
  };
}

feature("fleet hints synchronization", () => {
  unit("bridge startup invokes the fleet sync before publishing template provenance", {
    when: ["reading the production startup seam", () => readFileSync(
      new URL("../index.mjs", import.meta.url), "utf8",
    )],
    then: ["startup sync precedes the heartbeat", (source) => {
      const syncAt = source.indexOf("syncConfiguredAgentHints(listAgents(AGENTS_YAML)");
      const heartbeatAt = source.indexOf("startHeartbeat({");
      expect(syncAt).toBeGreaterThan(0);
      expect(heartbeatAt).toBeGreaterThan(syncAt);
    }],
  });

  component("one sync refreshes every unique configured workspace and preserves operator rules", {
    given: ["three sessions across two roots with one stale operator tail", () => fleetFixture()],
    when: ["syncing the configured fleet", (fx) => ({
      fx,
      first: syncConfiguredAgentHints(fx.agents, {
        ensure: ensureAgentHints,
        version: HINTS_VERSION,
      }),
    })],
    then: ["both harness files converge without duplicating the shared root", ({ fx, first }) => {
      expect(first).toMatchObject({
        version: HINTS_VERSION,
        configuredSessions: 3,
        workspaceRoots: 2,
        changedFiles: 4,
        errors: [],
      });
      const sharedClaude = readFileSync(join(fx.shared, ".agents", "CLAUDE.md"), "utf8");
      const sharedAgents = readFileSync(join(fx.shared, ".agents", "AGENTS.md"), "utf8");
      expect(sharedClaude).toContain(`<!-- amux-hints-version: ${HINTS_VERSION} -->`);
      expect(sharedClaude).toContain("KEEP_THIS_TAIL");
      expect(sharedClaude.slice(
        sharedClaude.indexOf(HINTS_END_MARKER) + HINTS_END_MARKER.length,
      )).toBe("\n\n# Workspace rules\nKEEP_THIS_TAIL\n");
      expect(sharedAgents).toBe(sharedClaude);
      expect(sharedAgents).not.toContain("STALE_NON_CANONICAL_TAIL");
      expect(readFileSync(join(fx.solo, ".agents", "CLAUDE.md"), "utf8"))
        .toContain(`<!-- amux-hints-version: ${HINTS_VERSION} -->`);

      const second = syncConfiguredAgentHints(fx.agents, {
        ensure: ensureAgentHints,
        version: HINTS_VERSION,
      });
      expect(second.changedFiles).toBe(0);

      // Version markers are an operator signal, not the drift oracle. A
      // same-version content mutation must still be repaired by comparison.
      writeFileSync(
        join(fx.shared, ".agents", "CLAUDE.md"),
        sharedClaude.replace("# agentmux", "# drifted-agentmux"),
      );
      const repaired = syncConfiguredAgentHints(fx.agents, {
        ensure: ensureAgentHints,
        version: HINTS_VERSION,
      });
      expect(repaired.changedFiles).toBe(1);
      expect(readFileSync(join(fx.shared, ".agents", "CLAUDE.md"), "utf8"))
        .toBe(sharedClaude);
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  component("a failed workspace is visible without blocking independent roots", {
    given: ["two roots and an injected first-root failure", () => ({
      agents: [{ name: "bad", dir: "/tmp/bad" }, { name: "good", dir: "/tmp/good" }],
      calls: [],
    })],
    when: ["syncing both", (ctx) => syncConfiguredAgentHints(ctx.agents, {
      version: "next",
      ensure: (rootDir) => {
        ctx.calls.push(rootDir);
        if (rootDir === "/tmp/bad") throw new Error("permission denied");
        return { files: [{ name: "CLAUDE.md", changed: true, error: null }] };
      },
    })],
    then: ["the good root advances and the failure is structured", (result) => {
      expect(result.changedFiles).toBe(1);
      expect(result.errors).toEqual([{
        rootDir: "/tmp/bad",
        agents: ["bad"],
        file: null,
        error: "permission denied",
      }]);
      expect(result.entries.map((entry) => entry.rootDir)).toEqual(["/tmp/bad", "/tmp/good"]);
    }],
  });
});

feature("running bridge template provenance", () => {
  unit("only a live bridge with a different or unknown template requires restart", {
    when: ["classifying current, stale, legacy and stopped heartbeats", () => ({
      current: assessRunningBridgeHints({ hintsVersion: "v2" }, {
        currentVersion: "v2", pidAlive: true,
      }),
      stale: assessRunningBridgeHints({ hintsVersion: "v1" }, {
        currentVersion: "v2", pidAlive: true,
      }),
      legacy: assessRunningBridgeHints({ version: "1.0.0" }, {
        currentVersion: "v2", pidAlive: true,
      }),
      stopped: assessRunningBridgeHints({ hintsVersion: "v1" }, {
        currentVersion: "v2", pidAlive: false,
      }),
    })],
    then: ["the in-memory overwrite risk is never silent", (states) => {
      expect(states.current).toMatchObject({ state: "current", restartRequired: false });
      expect(states.stale).toMatchObject({ state: "stale", restartRequired: true });
      expect(states.stale.warning).toContain("bridge restart required");
      expect(states.legacy.warning).toContain("running hints unknown");
      expect(states.stopped).toEqual({ state: "not-running", restartRequired: false });
    }],
  });

  unit("heartbeat persists the bridge in-memory hints version", {
    given: ["an isolated heartbeat path", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-hints-heartbeat-"));
      return { root, path: join(root, "heartbeat.json") };
    }],
    when: ["writing one bridge beat", (fx) => {
      writeHeartbeat({
        version: "1.2.3",
        sourceSha: "a".repeat(40),
        hintsVersion: "hints-v4",
        startedAt: "2026-07-15T00:00:00.000Z",
        path: fx.path,
        now: new Date("2026-07-15T01:00:00.000Z"),
      });
      return fx;
    }],
    then: ["the template provenance can be compared by a fresh CLI", (fx) => {
      expect(readHeartbeat(fx.path)).toMatchObject({
        version: "1.2.3",
        sourceSha: "a".repeat(40),
        hintsVersion: "hints-v4",
        startedAt: "2026-07-15T00:00:00.000Z",
      });
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });
});
