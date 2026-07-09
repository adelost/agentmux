#!/usr/bin/env node
// Claude Code hook -> amux event ledger. Installed by bin/install-hooks.mjs
// for Stop / Notification / UserPromptSubmit / SessionStart. The installed
// command is gated on $TMUX_PANE in shell, so non-tmux Claude sessions never
// pay the node startup.
//
// Contract: NEVER exit non-zero and NEVER hang. A non-zero Stop hook would
// block Claude from stopping; a slow hook delays every turn. Everything is
// wrapped, the tmux lookup has a hard timeout, and any failure means
// "record nothing" — the ledger is a hint layer, not a dependency. Failures
// still log to stderr (never silently: a dead ledger looks identical to
// "hooks not installed" otherwise).

import { execSync } from "child_process";
import { readFileSync } from "fs";
import { appendEvent, buildEvent } from "../core/events.mjs";
import { detectPaneAddress } from "../core/sender-detect.mjs";
import { buildResumeHint, shouldEmitResumeHint } from "../core/resume-hint.mjs";

try {
  const exec = (cmd) => execSync(cmd, { timeout: 3000, encoding: "utf-8" });
  const pane = detectPaneAddress(process.env, exec);
  if (pane) {
    let payload = {};
    try {
      payload = JSON.parse(readFileSync(0, "utf-8") || "{}");
    } catch (err) {
      console.error(`[amux-hook] stdin payload unparseable: ${err.message}`);
    }
    const evt = buildEvent(payload, pane);
    if (evt) appendEvent(evt);

    // Resume-hint via hook-context (1.20.52). Stdout on SessionStart is
    // injected as context, not as a user turn: the pane gets its pointer
    // without a false wake-up turn, and the hint is born inside the right
    // session so it can never be typed into another pane. transcript_path
    // is the session that just started — exclude it or the hint points at
    // itself. Own try/catch: a hint failure must not cost the ledger row.
    try {
      if (shouldEmitResumeHint(payload)) {
        const hint = buildResumeHint(payload.cwd || process.cwd(), {
          excludeJsonl: payload.transcript_path || null,
        });
        if (hint) process.stdout.write(hint);
      }
    } catch (err) {
      console.error(`[amux-hook] resume-hint skipped: ${err.message}`);
    }
  }
} catch (err) {
  // never break the agent; do leave a trace
  console.error(`[amux-hook] skipped: ${err.message}`);
}
process.exit(0);
