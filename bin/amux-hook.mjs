#!/usr/bin/env node
// Claude Code hook -> amux event ledger. Installed by bin/install-hooks.mjs
// for Stop / Notification / UserPromptSubmit / SessionStart.
//
// Contract: NEVER exit non-zero and NEVER hang. A non-zero Stop hook would
// block Claude from stopping; a slow hook delays every turn. Everything is
// wrapped, the tmux lookup has a hard timeout, and any failure means
// "record nothing" — the ledger is a hint layer, not a dependency.
//
// Not in tmux (plain interactive claude) -> exit 0 silently.

import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { appendEvent, buildEvent, parseTmuxSocket } from "../core/events.mjs";

function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

try {
  const socket = parseTmuxSocket(process.env.TMUX);
  const paneId = process.env.TMUX_PANE;
  if (socket && paneId) {
    let payload = {};
    try { payload = JSON.parse(readStdin() || "{}"); } catch {}

    const out = execFileSync(
      "tmux",
      ["-S", socket, "display-message", "-p", "-t", paneId, "#{session_name}\t#{pane_index}"],
      { timeout: 3000, encoding: "utf-8" },
    ).trim();
    const [session, pane] = out.split("\t");

    const evt = buildEvent(payload, { session, pane });
    if (evt) appendEvent(evt);
  }
} catch {
  // swallow everything: hooks must never break the agent
}
process.exit(0);
