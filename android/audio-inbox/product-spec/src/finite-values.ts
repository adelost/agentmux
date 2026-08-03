import { finiteValues } from "@v1d/product-spec";
import { linkRoutes } from "./catalog.js";

export const linkFiniteValues = [
  finiteValues("link.route", linkRoutes.map(({ id }) => id)),
  finiteValues("link.capture-operation", ["BEGIN", "RELEASE", "CANCEL"]),
  finiteValues("link.capture-phase", ["IDLE", "LISTENING", "FINALIZING", "FAILED"]),
  finiteValues("link.delivery-phase", ["SENDING", "QUEUED", "FAILED"]),
  finiteValues("link.reply-phase", ["NONE", "THINKING", "READY", "FAILED"]),
  finiteValues("link.playback-operation", ["PLAY", "PAUSE", "RESUME", "STOP"]),
  finiteValues("link.playback-phase", [
    "IDLE", "QUEUED", "PLAYING", "PAUSED", "STOPPED", "PLAYED", "SKIPPED", "FAILED",
  ]),
] as const;
