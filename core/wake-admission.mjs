// On-demand wake admission (T8/T13 seam).
//
// deliverToPane → sendOnly → ensureReady already wakes exactly the addressed
// pane when a durable message targets it. This gate makes that wake
// fail-closed: the message stays durably queued with a classified reason
// when the host cannot prove a verified release, memory headroom, or a live
// session provenance. Identity truth comes from the single existing
// contract (observeReleaseIdentity + identityDecision) — never a parallel
// weaker copy. A wake is only gated when the pane's agent process is not
// already running; delivery to a running pane is never gated.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { identityDecision, observeReleaseIdentity } from "./release-identity.mjs";
import { canStartHeavy, memoryGuardStatePath, readGuardState } from "./memory-guard.mjs";

/** WHAT: Checks the installed release identity for one wake decision. WHY: Keeps wake trust on the single identity contract. */
export function observeWakeIdentity({
  runtimeRoot,
  entryPath,
  home = homedir(),
  observe = observeReleaseIdentity,
} = {}) {
  const identity = observe({
    runtimeRoot,
    entryPath,
    home,
    // Remote master may warn, never block a wake: offline proof stays local.
    readRemoteMaster: () => { throw new Error("offline: wake identity is local-only"); },
  });
  return identityDecision(identity);
}

/** WHAT: Maps identity and memory state to one on-demand pane wake decision. WHY: Keeps durable delivery from starting panes into an unverified or pressured host. */
export function checkWakeAdmission({
  identity,
  guardState,
  nowMs = Date.now(),
  bootId = null,
  automatic = true,
  reserveMiB = 0,
} = {}) {
  if (!automatic) return { ok: true, reason: "manual-override" };
  if (!identity?.allowRevive) return { ok: false, reason: `identity-${identity?.reason || "unverified"}` };
  // Alert hysteresis deliberately holds a prior critical level until the host
  // has substantial clear headroom.  A single-pane message wake is narrower:
  // when the latest persisted sample itself classifies normal, use that fresh
  // truth plus the reserve floor instead of stranding the pane behind an old
  // alert level.  Blocked/warn samples and stale state remain fail-closed.
  const admissionState = guardState?.classified === "normal"
    ? { ...guardState, level: "normal" }
    : guardState;
  const verdict = canStartHeavy(admissionState, {
    class: "pane-revive",
    reserveMiB,
    automatic: true,
    nowMs,
    bootId,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return {
    ok: true,
    reason: admissionState !== guardState ? "current-memory-normal" : "ok",
  };
}

/** WHAT: Maps one pane process snapshot to whether a wake is needed. WHY: Separates waking a stopped pane from delivering to a live one. */
export function paneNeedsWake(processState) {
  if (!processState) return true;
  return processState.running !== true;
}

/** WHAT: Builds the broker's wake gate over identity and memory state. WHY: Keeps wake checks out of the delivery loop. */
export function createWakeAdmissionGate({
  runtimeRoot,
  entryPath = null,
  home = homedir(),
  now = () => Date.now(),
  readFile = (path) => readFileSync(path, "utf8"),
  observe,
  reserveMiB = 0,
} = {}) {
  const currentBootId = () => {
    try { return readFile("/proc/sys/kernel/random/boot_id").trim(); }
    catch { return null; }
  };
  return async () => checkWakeAdmission({
    identity: observeWakeIdentity({
      runtimeRoot,
      entryPath: entryPath || join(runtimeRoot, "bin", "agent-cli.mjs"),
      home,
      observe,
    }),
    guardState: readGuardState({ path: memoryGuardStatePath() }),
    nowMs: now(),
    bootId: currentBootId(),
    reserveMiB,
  });
}
