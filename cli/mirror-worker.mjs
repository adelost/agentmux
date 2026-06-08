#!/usr/bin/env node
// Detached Discord mirror worker for CLI sends.
//
// Tmux delivery is source-of-truth. This worker keeps Discord transparency
// best-effort without letting a slow Discord REST call block the `amux` CLI.

import { sendToChannelId } from "./send-notify.mjs";
import { readFileSync, rmSync } from "fs";
import { dirname } from "path";

function readOpts() {
  const optsFile = process.env.AMUX_MIRROR_OPTS_FILE;
  try {
    if (optsFile) return JSON.parse(readFileSync(optsFile, "utf-8"));
    return JSON.parse(process.env.AMUX_MIRROR_OPTS || "{}");
  } catch {
    return {};
  } finally {
    if (optsFile) rmSync(dirname(optsFile), { recursive: true, force: true });
  }
}

const { channelId, content } = readOpts();

try {
  if (channelId && content) await sendToChannelId(channelId, content);
} catch (err) {
  // stdio is normally ignored. Keep stderr useful when run manually.
  console.warn(`mirror-worker: ${err.message}`);
}
