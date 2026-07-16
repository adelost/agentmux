import { execFileSync } from "node:child_process";
import { chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANARY = join(ROOT, "spikes", "web-ui", "tools", "claude-persistent-process-canary.mjs");
const FAKE_CLAUDE = join(ROOT, "test", "fixtures", "fake-claude-persistent-stream.mjs");

describe("Claude persistent-process canary", () => {
  it("proves stable sessions, soft interrupt, recovery and comparable cache receipts", () => {
    chmodSync(FAKE_CLAUDE, 0o755);
    const output = execFileSync(process.execPath, [
      CANARY,
      "--corpus-lines", "20",
      "--timeout", "10000",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ANTHROPIC_API_KEY: "", CLAUDE_BIN: FAKE_CLAUDE },
      timeout: 30_000,
    });
    const proof = JSON.parse(output);

    expect(proof.ok).toBe(true);
    expect(proof.auth).toMatchObject({ authMethod: "claude.ai", subscriptionType: "max" });
    expect(proof.persistent.observedModels).toEqual(["claude-haiku-fake"]);
    expect(proof.persistent.interrupt).toBe("PASS");
    expect(proof.persistent.postInterruptRecovery).toBe("PASS");
    expect(proof.spawnResume.pids).toHaveLength(3);
    expect(new Set(proof.spawnResume.pids).size).toBe(3);
    expect(proof.cacheEconomics).toMatchObject({
      verdict: "persistent-no-worse",
      persistentLater: 20,
      resumedLater: 20,
      ratio: 1,
    });
  });
});
