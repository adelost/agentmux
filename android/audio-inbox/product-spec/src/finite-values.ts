import { finiteValues } from "@v1d/product-spec";
import { linkRoutes } from "./catalog.js";

export const linkFiniteValues = [
  finiteValues("link.route", linkRoutes.map(({ id }) => id)),
  finiteValues("link.capture-operation", ["begin", "release", "cancel"]),
  finiteValues("link.capture-phase", ["idle", "listening", "finalizing", "failed"]),
  finiteValues("link.delivery-phase", ["sending", "queued", "failed"]),
  finiteValues("link.reply-phase", ["none", "thinking", "ready", "failed"]),
  finiteValues("link.playback-operation", ["play", "pause", "resume", "stop"]),
  finiteValues("link.playback-phase", [
    "idle", "queued", "playing", "paused", "stopped", "played", "skipped", "failed",
  ]),
] as const;
