#!/usr/bin/env node
/**
 * WHAT: Claude PreToolUse hook. Holds a `git commit` that changes a hot function without a current verdict and
 * hands the agent the review brief; `amux churn verdict` releases it.
 * WHY: Mattias 2026-09-16 wanted every repo, new ones included, to always reflect on functions that keep churning.
 * The hold demands a verdict, never a rewrite.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const block = (text) => {
  console.error(`BLOCKED: ${text}`);
  process.exit(2);
};

/** Evaluation failures stay visible to the person but never stop a commit: this guard asks for reflection, not safety. */
function allowWithWarning(message) {
  try {
    const dir = join(homedir(), ".agentmux", "hotspots");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "guard-errors.log"), `${new Date().toISOString()} ${message}\n`);
  } catch (error) {
    message += ` (and the error log could not be written: ${error.message})`;
  }
  console.log(JSON.stringify({ systemMessage: `hotspot guard could not evaluate this commit: ${message}` }));
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
  const { commitDirectories, formatReflectionBrief } = await import("../core/hotspots.mjs");
  const { changedHotspotsDue, hotspotRepo } = await import("../core/hotspots-repo.mjs");
  const directories = commitDirectories(payload.tool_input?.command, payload.cwd || process.cwd(), homedir());
  const briefs = [];
  for (const directory of directories) {
    const repo = hotspotRepo(directory);
    if (!repo) continue;
    const due = await changedHotspotsDue(repo);
    if (due.length) briefs.push(`${repo.root}\n${formatReflectionBrief(due, repo.policy)}`);
  }
  if (briefs.length) block(briefs.join("\n\n"));
} catch (error) {
  allowWithWarning(error.message);
}
