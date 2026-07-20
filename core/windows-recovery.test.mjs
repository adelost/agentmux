import { expect, feature, unit } from "bdd-vitest";
import {
  RECOVERY_STAGES,
  classifyAuthFailure,
  formatRecoveryReport,
  mapRecoveryChainResults,
  planPostWslRecovery,
} from "./windows-recovery.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const BOOT_OLD = "11111111-2222-3333-4444-555555555555";
const BOOT_NEW = "66666666-7777-8888-9999-000000000000";

function goodInput(overrides = {}) {
  return {
    beforeBootId: BOOT_OLD,
    afterBootId: BOOT_NEW,
    bridgeSourceSha: SHA_A,
    installedSourceSha: SHA_A,
    dryRevive: ["alpha:0", "beta:1"],
    memoryLevel: "normal",
    bridgeOk: true,
    pendingDeliveries: 0,
    revived: ["alpha:0", "beta:1"],
    ...overrides,
  };
}

function stageOf(plan, name) {
  return plan.stages.find((stage) => stage.stage === name);
}

feature("windows post-WSL recovery core", () => {
  unit("the chain is exactly six ordered stages ending with the report", {
    then: ["ordering is fixed and the full pass classifies RECOVERED", () => {
      const plan = planPostWslRecovery(goodInput());
      expect(plan.stages.map((stage) => stage.stage)).toEqual([...RECOVERY_STAGES]);
      expect(plan.outcome).toBe("RECOVERED");
      expect(plan.failedStage).toBe(null);
      expect(plan.stages.every((stage) => stage.ok)).toBe(true);
      expect(stageOf(plan, "report").detail).toBe("stopped:none");
    }],
  });

  unit("boot identity requires a fresh proven boot", {
    then: ["changed ids pass, null before passes, same or missing ids block the whole chain", () => {
      const changed = stageOf(planPostWslRecovery(goodInput()), "boot-identity");
      expect(changed.ok).toBe(true);
      expect(changed.detail).toBe(`boot:${BOOT_NEW.slice(0, 12)}`);
      const unknownBefore = planPostWslRecovery(goodInput({ beforeBootId: null }));
      expect(stageOf(unknownBefore, "boot-identity").ok).toBe(true);
      for (const overrides of [{ afterBootId: BOOT_OLD }, { afterBootId: null }, { afterBootId: "" }]) {
        const plan = planPostWslRecovery(goodInput(overrides));
        const boot = stageOf(plan, "boot-identity");
        expect(boot.ok).toBe(false);
        expect(boot.detail).toBe(overrides.afterBootId ? "boot-id-unchanged" : "boot-id-missing");
        expect(stageOf(plan, "release-identity").detail).toBe("skipped:boot-identity");
        expect(plan.outcome).toBe("BLOCKED");
        expect(plan.failedStage).toBe("boot-identity");
      }
    }],
  });

  unit("release identity requires equal proven SHAs", {
    then: ["mismatch, missing, and skip each refuse honestly", () => {
      const mismatch = planPostWslRecovery(goodInput({ installedSourceSha: SHA_B }));
      expect(stageOf(mismatch, "release-identity")).toEqual({
        stage: "release-identity", ok: false, detail: "sha-mismatch",
      });
      expect(mismatch.outcome).toBe("PARTIAL");
      expect(mismatch.failedStage).toBe("release-identity");
      const missing = planPostWslRecovery(goodInput({ installedSourceSha: null }));
      expect(stageOf(missing, "release-identity").detail).toBe("sha-missing");
      const skipped = planPostWslRecovery(goodInput({ afterBootId: BOOT_OLD }));
      expect(stageOf(skipped, "release-identity").detail).toBe("skipped:boot-identity");
    }],
  });

  unit("the bridge stage reflects the measured start only after both identities", {
    then: ["authorized, started, and failed are distinct", () => {
      const authorized = planPostWslRecovery(goodInput({ bridgeOk: null }));
      expect(stageOf(authorized, "bridge")).toEqual({ stage: "bridge", ok: true, detail: "start-authorized" });
      const started = planPostWslRecovery(goodInput());
      expect(stageOf(started, "bridge").detail).toBe("bridge-started");
      const failed = planPostWslRecovery(goodInput({ bridgeOk: false }));
      expect(stageOf(failed, "bridge")).toEqual({ stage: "bridge", ok: false, detail: "bridge-start-failed" });
      expect(stageOf(failed, "drain").detail).toBe("skipped:bridge");
      expect(failed.outcome).toBe("PARTIAL");
      const gated = planPostWslRecovery(goodInput({ installedSourceSha: SHA_B, bridgeOk: null }));
      expect(stageOf(gated, "bridge")).toEqual({ stage: "bridge", ok: false, detail: "skipped:release-identity" });
    }],
  });

  unit("the drain stage requires a measured empty durable queue", {
    then: ["empty passes, pending and unmeasured refuse", () => {
      expect(stageOf(planPostWslRecovery(goodInput()), "drain").detail).toBe("queue-empty");
      const pending = planPostWslRecovery(goodInput({ pendingDeliveries: 3 }));
      expect(stageOf(pending, "drain")).toEqual({ stage: "drain", ok: false, detail: "pending:3" });
      const unmeasured = planPostWslRecovery(goodInput({ pendingDeliveries: null }));
      expect(stageOf(unmeasured, "drain")).toEqual({ stage: "drain", ok: false, detail: "queue-unmeasured" });
    }],
  });

  unit("revive runs only when every earlier stage is ok", {
    then: ["any earlier failure skips revive with the exact stage named", () => {
      const plan = planPostWslRecovery(goodInput({ pendingDeliveries: 2 }));
      expect(stageOf(plan, "revive")).toEqual({ stage: "revive", ok: false, detail: "skipped:drain" });
      expect(plan.outcome).toBe("PARTIAL");
      const authorized = planPostWslRecovery(goodInput({ revived: null }));
      expect(stageOf(authorized, "revive")).toEqual({ stage: "revive", ok: true, detail: "revive-authorized" });
    }],
  });

  unit("the memory admission guard refuses revive on warn, blocked, and critical", {
    then: ["each refused level marks the revive stage admission-refused", () => {
      for (const memoryLevel of ["warn", "blocked", "critical"]) {
        const plan = planPostWslRecovery(goodInput({ memoryLevel, revived: null }));
        expect(stageOf(plan, "revive")).toEqual({ stage: "revive", ok: false, detail: "admission-refused" });
        expect(plan.outcome).toBe("PARTIAL");
        expect(plan.failedStage).toBe("revive");
        expect(stageOf(plan, "report").detail).toBe("stopped:alpha:0,beta:1");
      }
      for (const memoryLevel of ["normal", "ok", null, "unknown"]) {
        expect(stageOf(planPostWslRecovery(goodInput({ memoryLevel })), "revive").ok).toBe(true);
      }
    }],
  });

  unit("panes that remain stopped keep the outcome honest", {
    then: ["a partial revive is PARTIAL with the exact stopped names", () => {
      const plan = planPostWslRecovery(goodInput({ revived: ["alpha:0"] }));
      expect(stageOf(plan, "revive")).toEqual({ stage: "revive", ok: true, detail: "revived:1" });
      expect(stageOf(plan, "report")).toEqual({ stage: "report", ok: false, detail: "stopped:beta:1" });
      expect(plan.outcome).toBe("PARTIAL");
      expect(plan.failedStage).toBe("report");
      const dryObjects = planPostWslRecovery(goodInput({
        dryRevive: [{ agent: "alpha", pane: 0 }],
        revived: ["alpha:0"],
      }));
      expect(stageOf(dryObjects, "report").detail).toBe("stopped:none");
    }],
  });

  unit("an auth failure replaces the failing stage detail and classifies", {
    then: ["downstream stages skip and the outcome stays honest", () => {
      const plan = planPostWslRecovery(goodInput({ installedSourceSha: null, authFailure: "release-identity" }));
      expect(stageOf(plan, "release-identity")).toEqual({
        stage: "release-identity", ok: false, detail: "auth-failure",
      });
      expect(stageOf(plan, "bridge").detail).toBe("skipped:release-identity");
      expect(plan.outcome).toBe("PARTIAL");
    }],
  });

  unit("the Swedish report lists every stage and what remained stopped", {
    then: ["recovered, refused, skipped, partial, and auth variants all render", () => {
      const recovered = planPostWslRecovery(goodInput());
      const recoveredText = formatRecoveryReport(recovered.stages, recovered.outcome);
      expect(recoveredText).toContain("AMUX RECOVERED återställningskedja efter WSL-retur");
      expect(recoveredText).toContain("boot-identity: ok (boot:");
      expect(recoveredText).toContain("revive: ok (revived:2)");
      expect(recoveredText).toContain("Kvar stoppade: inga.");
      expect(recoveredText).not.toContain("—");

      const refused = planPostWslRecovery(goodInput({ memoryLevel: "warn", revived: null }));
      const refusedText = formatRecoveryReport(refused.stages, refused.outcome);
      expect(refusedText).toContain("AMUX PARTIAL");
      expect(refusedText).toContain("revive: FEL (admission-refused)");
      expect(refusedText).toContain("Revive nekades av minnesvakten (admission-refused). Kvar stoppade: alpha:0, beta:1.");

      const skipped = planPostWslRecovery(goodInput({ afterBootId: BOOT_OLD }));
      const skippedText = formatRecoveryReport(skipped.stages, skipped.outcome);
      expect(skippedText).toContain("AMUX BLOCKED");
      expect(skippedText).toContain("Revive hoppades över (skipped:boot-identity).");

      const partial = planPostWslRecovery(goodInput({ revived: ["alpha:0"] }));
      const partialText = formatRecoveryReport(partial.stages, partial.outcome);
      expect(partialText).toContain("Kvar stoppade: beta:1.");

      const auth = planPostWslRecovery(goodInput({ installedSourceSha: null, authFailure: "release-identity" }));
      const authText = formatRecoveryReport(auth.stages, auth.outcome);
      expect(authText).toContain("Autentiseringsfel klassificerat: återställning kräver en människa.");
    }],
  });

  unit("chain JSON maps to per-stage manager tool results", {
    then: ["six mirrored entries with the report on the last, invalid input refused", () => {
      const plan = planPostWslRecovery(goodInput());
      const report = formatRecoveryReport(plan.stages, plan.outcome);
      const results = mapRecoveryChainResults({ stages: plan.stages, outcome: plan.outcome, report });
      expect(results).toHaveLength(6);
      expect(results[0].stage).toBe("recover-verify:boot-identity");
      expect(results.every((entry) => entry.ok)).toBe(true);
      expect(results[5].detail).toBe(report);
      const refused = mapRecoveryChainResults({ stages: [], outcome: "BLOCKED" });
      expect(refused).toEqual([{ ok: false, stage: "recover-verify", detail: "chain-output-invalid" }]);
      expect(mapRecoveryChainResults(null)).toEqual(refused);
    }],
  });

  unit("auth markers are classified without matching runtime faults", {
    then: ["401, 403, unauthorized, invalid token, and env-missing classify; timeouts do not", () => {
      expect(classifyAuthFailure("Error: request failed with status 401")).toBe("auth-failure");
      expect(classifyAuthFailure("HTTP 403 Forbidden")).toBe("auth-failure");
      expect(classifyAuthFailure("discord unauthorized")).toBe("auth-failure");
      expect(classifyAuthFailure("invalid token provided")).toBe("auth-failure");
      expect(classifyAuthFailure("MANAGER_BLOCKED env-missing:DISCORD_TOKEN")).toBe("auth-failure");
      expect(classifyAuthFailure("process timed out after 20s")).toBe(null);
      expect(classifyAuthFailure("")).toBe(null);
      expect(classifyAuthFailure(null)).toBe(null);
    }],
  });
});
