// On-demand wake admission (T8/T13 seam).
//
// deliverToPane → sendOnly → ensureReady already wakes exactly the addressed
// pane when a durable message targets it. This gate makes that wake
// fail-closed: the message stays durably queued with a classified reason
// when the host cannot prove a verified release, memory headroom, or a live
// session provenance. A wake is only gated when the pane's agent process is
// not already running; delivery to a running pane is never gated.

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { RELEASE_MANIFEST_NAME, releaseReceiptPath } from "./release-identity.mjs";
import { canStartHeavy, memoryGuardStatePath, readGuardState } from "./memory-guard.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;

/** WHAT: Checks release identity locally enough to trust a pane wake. WHY: Prevents an unverified install from starting panes. */
export function localReleaseIdentity({
  runtimeRoot,
  home = homedir(),
  lstat = lstatSync,
  readJson = (path) => JSON.parse(readFileSync(path, "utf8")),
} = {}) {
  try {
    if (lstat(runtimeRoot).isSymbolicLink()) return { ok: false, reason: "linked-checkout" };
  } catch {
    return { ok: false, reason: "runtime-missing" };
  }
  let manifest = null;
  try { manifest = readJson(join(runtimeRoot, RELEASE_MANIFEST_NAME)); }
  catch { return { ok: false, reason: "manifest" }; }
  if (!manifest || !COMMIT_SHA.test(manifest.sourceSha || "")) {
    return { ok: false, reason: "manifest" };
  }
  let receipt = null;
  try { receipt = readJson(releaseReceiptPath(home)); }
  catch { return { ok: false, reason: "receipt" }; }
  if (receipt?.sourceSha !== manifest.sourceSha) return { ok: false, reason: "source-sha" };
  return { ok: true, sourceSha: manifest.sourceSha };
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
  if (!identity?.ok) return { ok: false, reason: `identity-${identity?.reason || "unverified"}` };
  const verdict = canStartHeavy(guardState, {
    class: "pane-revive",
    reserveMiB,
    automatic: true,
    nowMs,
    bootId,
  });
  if (!verdict.ok) return { ok: false, reason: verdict.reason };
  return { ok: true, reason: "ok" };
}

/** WHAT: Maps one pane process snapshot to whether a wake is needed. WHY: Separates waking a stopped pane from delivering to a live one. */
export function paneNeedsWake(processState) {
  if (!processState) return true;
  return processState.running !== true;
}

/** WHAT: Builds the broker's wake gate over identity and memory state. WHY: Keeps wake checks out of the delivery loop. */
export function createWakeAdmissionGate({
  runtimeRoot,
  home = homedir(),
  now = () => Date.now(),
  readFile = (path) => readFileSync(path, "utf8"),
  reserveMiB = 0,
} = {}) {
  const currentBootId = () => {
    try { return readFile("/proc/sys/kernel/random/boot_id").trim(); }
    catch { return null; }
  };
  return async () => checkWakeAdmission({
    identity: localReleaseIdentity({ runtimeRoot, home }),
    guardState: readGuardState({ path: memoryGuardStatePath() }),
    nowMs: now(),
    bootId: currentBootId(),
    reserveMiB,
  });
}
