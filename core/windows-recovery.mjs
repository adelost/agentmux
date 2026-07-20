// Windows post-WSL recovery chain: exact verification order after WSL returns.
// All decisions live here so they are vitest-able; bin/windows-recovery.mjs is
// a thin CLI and bin/windows-rescue-tool.ps1 only gathers bounded measurements.

import { classifyRecovery } from "./windows-bridge.mjs";

/** WHAT: Names the ordered post-WSL recovery stages. WHY: Keeps planner, CLI, and PowerShell on one explicit chain. */
export const RECOVERY_STAGES = Object.freeze([
  "boot-identity",
  "release-identity",
  "bridge",
  "drain",
  "revive",
  "report",
]);

const ADMISSION_REFUSED_LEVELS = new Set(["warn", "blocked", "critical"]);

function short(value) {
  const text = String(value || "");
  return text ? text.slice(0, 12) : "unknown";
}

function paneName(entry) {
  return typeof entry === "string" ? entry : `${entry?.agent ?? "?"}:${entry?.pane ?? "?"}`;
}

/** WHAT: Builds the ordered post-WSL recovery stages from measured inputs. WHY: Keeps every gating decision out of the PowerShell transport. */
export function planPostWslRecovery({
  beforeBootId = null,
  afterBootId = null,
  bridgeSourceSha = null,
  installedSourceSha = null,
  dryRevive = [],
  memoryLevel = null,
  bridgeOk = null,
  pendingDeliveries = null,
  revived = null,
  authFailure = null,
} = {}) {
  const wanted = (Array.isArray(dryRevive) ? dryRevive : []).map(paneName);
  const sent = revived == null ? null : (Array.isArray(revived) ? revived : []).map(paneName);
  const stages = [];
  const push = (stage, rule) => {
    const skipped = stages.find((entry) => !entry.ok)?.stage || null;
    const auth = authFailure === stage;
    const ok = !skipped && !auth && rule.ok;
    const detail = auth
      ? "auth-failure"
      : (skipped ? `skipped:${skipped}` : (rule.ok ? rule.detail : rule.refusal));
    stages.push({ stage, ok, detail });
    return ok;
  };

  const bootOk = Boolean(afterBootId) && (beforeBootId == null || String(afterBootId) !== String(beforeBootId));
  push("boot-identity", {
    ok: bootOk,
    detail: `boot:${short(afterBootId)}`,
    refusal: afterBootId ? "boot-id-unchanged" : "boot-id-missing",
  });

  const shaPair = Boolean(bridgeSourceSha) && Boolean(installedSourceSha);
  const shaOk = shaPair && String(bridgeSourceSha) === String(installedSourceSha);
  push("release-identity", {
    ok: shaOk,
    detail: `sha:${short(installedSourceSha)}`,
    refusal: shaPair ? "sha-mismatch" : "sha-missing",
  });

  push("bridge", {
    ok: bridgeOk !== false,
    detail: bridgeOk === true ? "bridge-started" : "start-authorized",
    refusal: "bridge-start-failed",
  });

  push("drain", {
    ok: pendingDeliveries === 0,
    detail: "queue-empty",
    refusal: pendingDeliveries == null ? "queue-unmeasured" : `pending:${pendingDeliveries}`,
  });

  const refused = ADMISSION_REFUSED_LEVELS.has(String(memoryLevel || "").toLowerCase());
  push("revive", {
    ok: !refused,
    detail: sent === null ? "revive-authorized" : `revived:${sent.length}`,
    refusal: "admission-refused",
  });

  const stopped = wanted.filter((name) => !(sent || []).includes(name));
  stages.push({
    stage: "report",
    ok: stages.every((stage) => stage.ok) && stopped.length === 0,
    detail: stopped.length ? `stopped:${stopped.join(",")}` : "stopped:none",
  });
  return { stages, ...classifyRecovery(stages) };
}

/** WHAT: Formats the compact Swedish recovery report for Discord. WHY: Keeps stopped panes and refusals visible without raw process output. */
export function formatRecoveryReport(stages = [], outcome = "BLOCKED") {
  const lines = [`AMUX ${outcome} återställningskedja efter WSL-retur`];
  for (const stage of stages || []) {
    lines.push(`${stage.stage}: ${stage.ok ? "ok" : "FEL"} (${stage.detail})`);
  }
  const detailOf = (name) => String((stages || []).find((stage) => stage.stage === name)?.detail || "");
  const revive = detailOf("revive");
  const stopped = detailOf("report").replace(/^stopped:/u, "");
  const named = stopped && stopped !== "none" ? stopped.split(",").filter(Boolean) : [];
  if (revive === "admission-refused") {
    lines.push(`Revive nekades av minnesvakten (admission-refused). Kvar stoppade: ${named.length ? named.join(", ") : "okänt"}.`);
  } else if (revive.startsWith("skipped:")) {
    lines.push(`Revive hoppades över (${revive}). Kvar stoppade: ${named.length ? named.join(", ") : "okänt"}.`);
  } else if (named.length) {
    lines.push(`Kvar stoppade: ${named.join(", ")}.`);
  } else {
    lines.push("Kvar stoppade: inga.");
  }
  if ((stages || []).some((stage) => stage.detail === "auth-failure")) {
    lines.push("Autentiseringsfel klassificerat: återställning kräver en människa.");
  }
  return lines.join("\n");
}

/** WHAT: Maps a recovery chain JSON to per-stage manager tool results. WHY: Keeps the manager outcome an exact mirror of the chain. */
export function mapRecoveryChainResults(parsed, { maxDetail = 800 } = {}) {
  if (!parsed || !Array.isArray(parsed.stages) || !parsed.stages.length) {
    return [{ ok: false, stage: "recover-verify", detail: "chain-output-invalid" }];
  }
  const results = parsed.stages.map((stage, index) => ({
    ok: stage?.ok === true,
    stage: `recover-verify:${String(stage?.stage || index)}`,
    detail: String(stage?.detail || "").slice(0, maxDetail),
  }));
  const report = String(parsed.report || "").trim();
  if (report) results[results.length - 1].detail = report.slice(0, 1750);
  return results;
}

/** WHAT: Checks bounded step output for auth failure markers. WHY: Separates token and permission faults from runtime faults. */
export function classifyAuthFailure(text) {
  const value = String(text || "").toLowerCase();
  if (!value.trim()) return null;
  if (/(^|\D)(401|403)(\D|$)/u.test(value)
    || value.includes("unauthorized")
    || value.includes("invalid token")
    || value.includes("env-missing")) {
    return "auth-failure";
  }
  return null;
}
