#!/usr/bin/env node
/**
 * WHAT: Claude PreToolUse hook. Refuses an Agent call that would fork the session and names the fresh-subagent
 * alternative.
 * WHY: Mattias 2026-10-10: "vi borde väl förbjuda det helt". Claude Code's own switch
 * (CLAUDE_CODE_FORK_SUBAGENT=0, set by install-hooks) removes the fork type; this guard turns its bare
 * "not found" into the instruction to start a fresh subagent with a brief.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { detectSenderFromEnv } from "../core/sender-detect.mjs";
import { claudeSubagentHook } from "../core/claude-subagent-cap.mjs";

/** Its own failures never stop a call: Claude Code's switch still refuses the fork behind it. */
function allowWithWarning(message) {
  try {
    const dir = join(homedir(), ".agentmux");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "fork-guard-errors.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // the log is a courtesy; the switch stands either way
  }
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch (error) {
  allowWithWarning(`unreadable hook payload: ${error.message}`);
}

try {
  const { FORK_REFUSAL, isForkRequest } = await import("../core/fork-guard.mjs");
  const pane = detectSenderFromEnv(process.env, command => execSync(command, { timeout: 1000, encoding: "utf8" }));
  const verdict = await claudeSubagentHook(payload, { pane, forkRefusal: isForkRequest(payload) ? FORK_REFUSAL : null });
  if (!verdict.allowed) {
    console.error(verdict.refusal);
    process.exit(2);
  }
  if (isForkRequest(payload)) {
    console.error(`BLOCKED: ${FORK_REFUSAL}`);
    process.exit(2);
  }
} catch (error) {
  allowWithWarning(error.message);
}
