#!/usr/bin/env node
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { bashPermissionDecision } from "../core/rm-target-guard.mjs";
import { permissionDecisionLine } from "../core/permission-watchdog.mjs";

try {
  const input = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (input.permission_mode === "bypassPermissions" && input.tool_name === "Bash") {
    if (typeof input.tool_input?.command !== "string" || !input.tool_input.command.trim()) throw new Error("Bash permission request has no command");
    const decision = bashPermissionDecision(input.tool_input?.command, homedir());
    const dir = join(homedir(), ".agentmux");
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "permission-watchdog.jsonl"), permissionDecisionLine({ at: Date.now(), paneKey: process.env.TMUX_PANE,
        sessionId: input.session_id, action: decision.behavior === "allow" ? "hook-allowed" : "hook-refused", why: decision.message || "Bash dialog allowed" }));
    } catch (error) { console.error(`permission guard log: ${error.message}`); }
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }));
  }
} catch (error) {
  try { appendFileSync(join(homedir(), ".agentmux", "permission-watchdog-errors.log"), `${new Date().toISOString()} ${error.stack}\n`); } catch { /* dialog remains */ }
}
