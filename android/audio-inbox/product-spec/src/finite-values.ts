import { finiteValues } from "@v1d/product-spec";

export const LINK_SCREENS = ["home", "settings", "dev-host"] as const;

export const linkFiniteValues = [
  finiteValues("link.route", LINK_SCREENS),
  finiteValues("link.capture-operation", ["begin", "release", "cancel"]),
  finiteValues("link.capture-phase", ["idle", "listening", "finalizing", "failed"]),
  finiteValues("link.delivery-phase", ["sending", "queued", "failed"]),
  finiteValues("link.reply-phase", ["none", "thinking", "ready", "failed"]),
  finiteValues("link.playback-operation", ["play", "pause", "resume", "stop"]),
  finiteValues("link.playback-phase", [
    "idle", "queued", "playing", "paused", "stopped", "played", "skipped", "failed",
  ]),
  finiteValues("link.target-kind", ["agent", "windows", "public"]),
  finiteValues("link.connection-state", [
    "off", "connecting", "connected", "disconnected", "configuration-required",
  ]),
  finiteValues("link.preference-key", ["hands-free", "speak-replies"]),
  finiteValues("link.update-operation", ["check", "retry", "install"]),
  finiteValues("link.update-phase", [
    "idle", "checking", "up-to-date", "unavailable", "available",
    "downloading", "ready-to-install", "installing", "install-failed", "failed",
  ]),
  finiteValues("link.recovery-phase", ["clean", "quarantined"]),
] as const;
