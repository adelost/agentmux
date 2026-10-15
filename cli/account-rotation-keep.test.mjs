import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rotateClaudeFleet } from "./account-rotation.mjs";

async function rotateWithActiveNeighbor(activeOnTarget) {
  const root = mkdtempSync(join(tmpdir(), "amux-keep-"));
  const sessionId = "11111111-1111-4111-8111-111111111111", path = join(root, `${sessionId}.jsonl`);
  writeFileSync(path, '{"type":"user"}\n');
  const values = { account_profile_by_pane_v1: { "demo:0": activeOnTarget ? "2" : "1" } };
  const restarts = [], compacts = [];
  const state = { get: (key, fallback) => values[key] ?? fallback, set: (key, value) => { values[key] = value; } };
  const catalog = ["1", "2"].map(id => ({ provider: "claude", id, home: `/profiles/${id}` }));
  const ctx = { state, deliveryQueue: { list: () => [], acquireSessionLease: () => ({ release() {} }) },
    agent: { paneProcessState: async () => ({ command: "claude", running: true }),
      isBusy: async (_name, pane) => pane === 0,
      promptTransportState: async (_name, pane) => ({ state: pane === 0 ? "working" : "empty-idle" }),
      restartClaudeAccount: async (_name, pane, launch) => { restarts.push({ pane, launch }); },
    } };
  try {
    const result = await rotateClaudeFleet(ctx, "2", {}, {
      agents: [{ name: "demo", dir: root, panes: [0, 1].map(() => ({ cmd: "claude", accountProfile: 1 })) }],
      catalog, authenticated: () => true, identityOf: profile => ({ email: `${profile.id}@example.com` }),
      access: async () => ({ ok: true }), prepare() {}, output() {}, setExitCode() {},
      latestIdentity: cwd => ({ sessionId, path, cwd }),
      observeContext: async () => ({ facts: { tokens: 120_000, idleMs: 60_000 }, compactRefusal: null }),
      compactPane: async target => { compacts.push(target); return { ok: true }; },
    });
    return { result, restarts, compacts, selected: values.account_profile_by_pane_v1 };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

feature("Claude rotation leaves active KEEP panes untouched", () => {
  component("a busy neighbor already on target does not block an idle mover", {
    given: ["an active target-account pane and an idle old-account neighbor", () => true],
    when: ["moving the project through its normal compact and restart path", rotateWithActiveNeighbor],
    then: ["the active pane stays KEEP and only its neighbor is compacted and restarted", ({ result, restarts, compacts, selected }) => {
      expect(result.status).toBe("RECOVERED");
      expect(result.rows.map(row => row.status)).toEqual(["already-selected", "switched"]);
      expect(restarts.map(item => item.pane)).toEqual([1]);
      expect(restarts[0].launch.resumeSessionId).toBe("11111111-1111-4111-8111-111111111111");
      expect(compacts).toHaveLength(1);
      expect(selected).toEqual({ "demo:0": "2", "demo:1": "2" });
    }],
  });
  component("a busy neighbor that needs to move still blocks the project", {
    given: ["an active old-account pane and an idle old-account neighbor", () => false],
    when: ["requesting the same account rotation", rotateWithActiveNeighbor],
    then: ["the original busy-turn guards refuse all process and account changes", ({ result, restarts, compacts, selected }) => {
      expect(result.status).toBe("BLOCKED");
      expect(result.rows[0].reason).toBe("active-or-unknown-turn");
      expect(restarts).toEqual([]);
      expect(compacts).toEqual([]);
      expect(selected).toEqual({ "demo:0": "1" });
    }],
  });
});
