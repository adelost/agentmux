import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, feature, unit } from "bdd-vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "windows-recovery.mjs");
const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64");

function run(args, { expectFailure = false } = {}) {
  try {
    return { ok: true, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8" }).trim() };
  } catch (error) {
    if (!expectFailure) throw error;
    return { ok: false, status: error.status, stderr: String(error.stderr || "").trim() };
  }
}

const GOOD = {
  beforeBootId: "11111111-2222-3333-4444-555555555555",
  afterBootId: "66666666-7777-8888-9999-000000000000",
  bridgeSourceSha: "a".repeat(40),
  installedSourceSha: "a".repeat(40),
  dryRevive: ["alpha:0"],
  memoryLevel: "normal",
  bridgeOk: true,
  pendingDeliveries: 0,
  revived: ["alpha:0"],
};

feature("windows recovery CLI mapping", () => {
  unit("stages prints the fixed ordered chain as JSON", {
    then: ["six stage names in contract order", () => {
      const result = run(["stages"]);
      expect(result.ok).toBe(true);
      expect(JSON.parse(result.stdout)).toEqual([
        "boot-identity", "release-identity", "bridge", "drain", "revive", "report",
      ]);
    }],
  });

  unit("plan maps measured input to stages, outcome, and report", {
    then: ["a full pass is RECOVERED with the Swedish report embedded", () => {
      const result = run(["plan", "--input-base64", encode(GOOD)]);
      expect(result.ok).toBe(true);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.stages).toHaveLength(6);
      expect(parsed.outcome).toBe("RECOVERED");
      expect(parsed.failedStage).toBe(null);
      expect(parsed.report).toContain("AMUX RECOVERED");
      expect(parsed.report).toContain("Kvar stoppade: inga.");
    }],
  });

  unit("plan carries each refusal class through to the CLI output", {
    then: ["boot mismatch blocks, sha mismatch and memory warn are PARTIAL", () => {
      const blocked = JSON.parse(run(["plan", "--input-base64", encode({
        ...GOOD, afterBootId: GOOD.beforeBootId,
      })]).stdout);
      expect(blocked.outcome).toBe("BLOCKED");
      expect(blocked.stages[0]).toEqual({ stage: "boot-identity", ok: false, detail: "boot-id-unchanged" });
      const mismatched = JSON.parse(run(["plan", "--input-base64", encode({
        ...GOOD, installedSourceSha: "b".repeat(40),
      })]).stdout);
      expect(mismatched.outcome).toBe("PARTIAL");
      expect(mismatched.failedStage).toBe("release-identity");
      const refused = JSON.parse(run(["plan", "--input-base64", encode({
        ...GOOD, memoryLevel: "warn", revived: null,
      })]).stdout);
      expect(refused.outcome).toBe("PARTIAL");
      expect(refused.stages[4]).toEqual({ stage: "revive", ok: false, detail: "admission-refused" });
      expect(refused.report).toContain("Kvar stoppade: alpha:0.");
    }],
  });

  unit("format renders the report text from a staged input", {
    then: ["plain text output with stage lines", () => {
      const plan = JSON.parse(run(["plan", "--input-base64", encode(GOOD)]).stdout);
      const result = run(["format", "--input-base64", encode({ stages: plan.stages, outcome: plan.outcome })]);
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain("boot-identity: ok");
      expect(result.stdout).not.toContain("{");
    }],
  });

  unit("classify-auth maps text to a JSON boolean", {
    then: ["auth markers true, runtime faults false", () => {
      expect(JSON.parse(run(["classify-auth", "--input-base64", encode("HTTP 401 unauthorized")]).stdout))
        .toEqual({ authFailure: true });
      expect(JSON.parse(run(["classify-auth", "--input-base64", encode("heartbeat-timeout")]).stdout))
        .toEqual({ authFailure: false });
    }],
  });

  unit("bad usage and bad input fail closed", {
    then: ["missing command exits 2, invalid base64 exits non-zero", () => {
      const usage = run([], { expectFailure: true });
      expect(usage.ok).toBe(false);
      expect(usage.status).toBe(2);
      expect(usage.stderr).toContain("Usage:");
      const bad = run(["plan", "--input-base64", "!!!not-base64!!!"], { expectFailure: true });
      expect(bad.ok).toBe(false);
      expect(bad.stderr).toContain("input-base64-missing-or-invalid");
    }],
  });
});
