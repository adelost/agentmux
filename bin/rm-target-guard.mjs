#!/usr/bin/env node
/**
 * WHAT: Claude PreToolUse hook. Refuses a Bash command whose rm target Claude Code would stop for a person, and
 * tells the agent the form the check accepts.
 * WHY: Mattias 2026-09-29, after lsrc:1 waited 6 minutes on such a prompt: "jag tycker inte den ska pausa". The
 * refusal costs one retry; the prompt costs minutes, and only a person may answer it.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Its own failures never stop a command: the check it runs ahead of still stands behind it. */
function allowWithWarning(message) {
  try {
    const dir = join(homedir(), ".agentmux");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "rm-target-guard-errors.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // the log is a courtesy; the command goes on either way
  }
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch (error) {
  allowWithWarning(`unreadable hook payload: ${error.message}`);
}
if (payload.tool_name !== "Bash") process.exit(0);

try {
  const { formatRmRefusal, stoppingRmTargets } = await import("../core/rm-target-guard.mjs");
  const found = stoppingRmTargets(payload.tool_input?.command);
  if (found.length) {
    console.error(`BLOCKED: ${formatRmRefusal(found)}`);
    process.exit(2);
  }
} catch (error) {
  allowWithWarning(error.message);
}
