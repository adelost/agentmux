import { finiteValues } from "@v1d/product-spec";

export const linkCaptureOperations = finiteValues("link.capture-operation", ["begin", "release", "cancel"]);
export const linkCapturePhases = finiteValues("link.capture-phase", ["idle", "listening", "finalizing", "failed"]);
export const linkDeliveryPhases = finiteValues("link.delivery-phase", ["none", "sending", "queued", "failed"]);
export const linkReplyPhases = finiteValues("link.reply-phase", ["none", "thinking", "ready", "failed"]);
export const linkPlaybackOperations = finiteValues("link.playback-operation", ["play", "pause", "resume", "stop"]);
export const linkPlaybackPhases = finiteValues("link.playback-phase", [
  "idle", "queued", "playing", "paused", "stopped", "played", "skipped", "failed",
]);
export const linkTargetKinds = finiteValues("link.target-kind", ["none", "agent", "windows", "public"]);
export const linkConnectionStates = finiteValues("link.connection-state", [
  "off", "connecting", "connected", "disconnected", "configuration-required",
]);
export const linkPreferenceKeys = finiteValues("link.preference-key", ["hands-free", "speak-replies"]);
export const linkUpdateOperations = finiteValues("link.update-operation", ["check", "retry", "install"]);
export const linkUpdatePhases = finiteValues("link.update-phase", [
  "idle", "checking", "up-to-date", "unavailable", "available",
  "downloading", "ready-to-install", "installing", "install-failed", "failed",
]);
export const linkRecoveryPhases = finiteValues("link.recovery-phase", ["clean", "quarantined"]);

export const linkFiniteValues = [
  linkCaptureOperations,
  linkCapturePhases,
  linkDeliveryPhases,
  linkReplyPhases,
  linkPlaybackOperations,
  linkPlaybackPhases,
  linkTargetKinds,
  linkConnectionStates,
  linkPreferenceKeys,
  linkUpdateOperations,
  linkUpdatePhases,
  linkRecoveryPhases,
] as const;
