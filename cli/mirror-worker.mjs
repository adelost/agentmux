#!/usr/bin/env node
// Detached Discord mirror worker for CLI sends.
//
// Tmux delivery is source-of-truth. This worker keeps Discord transparency
// best-effort without letting a slow Discord REST call block the `amux` CLI.

import { sendToChannelId } from "./send-notify.mjs";
import { readFileSync, rmSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "node:url";

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

/** WHAT: Dispatches one mirror with the queue's stable identity. WHY: Keeps a detached retry from creating another copy of the same report. */
export async function deliverMirror({ channelId, content, idempotencyKey }, send = sendToChannelId) {
  if (channelId && content) return send(channelId, content, { kind: "mirror", idempotencyKey });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await deliverMirror(readOpts()); }
  catch (err) { console.warn(`mirror-worker: ${err.message}`); }
}
