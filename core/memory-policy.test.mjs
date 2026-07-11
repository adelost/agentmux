import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  DEFAULT_MEMORY_POLICY, dailyPolicyFor, loadMemoryPolicy, localDateKey,
} from "./memory-policy.mjs";

const NOW = new Date("2026-07-11T10:00:00+02:00");

feature("memory policy", () => {
  unit("today and yesterday are always protected", {
    when: ["resolving daily policy", () => [
      dailyPolicyFor("2026-07-11", DEFAULT_MEMORY_POLICY, NOW),
      dailyPolicyFor("2026-07-10", DEFAULT_MEMORY_POLICY, NOW),
    ]],
    then: ["both are protected", (rows) => {
      expect(rows.every((row) => row.protected)).toBe(true);
    }],
  });

  unit("recent and old files get different limits and targets", {
    when: ["resolving two dates", () => ({
      recent: dailyPolicyFor("2026-07-01", DEFAULT_MEMORY_POLICY, NOW),
      old: dailyPolicyFor("2026-05-01", DEFAULT_MEMORY_POLICY, NOW),
    })],
    then: ["recent targets 20, old targets 5", ({ recent, old }) => {
      expect(recent).toMatchObject({ maxLines: 100, targetLines: 20 });
      expect(old).toMatchObject({ maxLines: 30, targetLines: 5 });
    }],
  });

  unit("workspace YAML overrides defaults and rejects unknown keys", {
    given: ["a policy file", () => {
      const workspace = mkdtempSync(join(tmpdir(), "amux-memory-policy-"));
      mkdirSync(join(workspace, "memory"));
      writeFileSync(join(workspace, "memory", ".memory-policy.yaml"), "maxCompactions: 2\n");
      return { workspace };
    }],
    when: ["loading", ({ workspace }) => loadMemoryPolicy(workspace)],
    then: ["the override is applied without dropping defaults", (policy) => {
      expect(policy.maxCompactions).toBe(2);
      expect(policy.memoryMaxBytes).toBe(4096);
    }],
  });

  unit("Stockholm date keys do not depend on host timezone", {
    when: ["formatting", () => localDateKey(new Date("2026-07-10T22:30:00Z"))],
    then: ["the local day is July 11", (key) => expect(key).toBe("2026-07-11")],
  });
});
