#!/usr/bin/env node
/**
 * WHAT: Emits a project MEMORY.md size hint once per file and session.
 * WHY: Keeps the compact startup registry bounded without prompting workers to maintain manual daily diaries.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const RUNTIME = join(homedir(), ".agentmux");
const STATE = join(RUNTIME, "memory-section-reminders.json");

/** Its own failures stay out of the writer's turn; the nightly lint still names the section. */
function quietExit(message) {
  try {
    mkdirSync(RUNTIME, { recursive: true });
    appendFileSync(join(RUNTIME, "memory-section-reminder-errors.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // the log is a courtesy
  }
  process.exit(0);
}

function readState() {
  try { return JSON.parse(readFileSync(STATE, "utf8")); } catch { return { sessions: {} }; }
}

function writeState(state) {
  mkdirSync(RUNTIME, { recursive: true });
  const temp = `${STATE}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state)}\n`);
  renameSync(temp, STATE);
}

let payload;
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch (error) {
  quietExit(`unreadable hook payload: ${error.message}`);
}

try {
  const { writtenMemoryIndexes } = await import("../core/memory-section-reminder.mjs");
  const { DEFAULT_MEMORY_POLICY, dateKeyDaysAgo, loadMemoryPolicy, localDateKey } = await import("../core/memory-policy.mjs");
  const indexes = writtenMemoryIndexes(payload);
  if (!indexes.length) process.exit(0);

  const state = readState();
  if (!state.sessions || typeof state.sessions !== "object") state.sessions = {};
  const yesterday = dateKeyDaysAgo(1);
  for (const [id, session] of Object.entries(state.sessions)) {
    if (!(session?.day >= yesterday)) delete state.sessions[id];
  }
  const sessionId = String(payload.session_id || "no-session");
  const session = state.sessions[sessionId] || { day: localDateKey(), keys: [] };

  const messages = [];
  for (const index of indexes) {
    const key = `index:${index.path}`;
    if (session.keys.includes(key)) continue;
    let text;
    try { text = readFileSync(index.path, "utf8"); } catch { continue; }
    let maxChars = DEFAULT_MEMORY_POLICY.claudeMemoryIndexMaxChars;
    try { maxChars = loadMemoryPolicy(dirname(dirname(index.path))).claudeMemoryIndexMaxChars; } catch {
      // Lint owns invalid policies; the shared default still applies here.
    }
    const chars = [...text].length;
    if (chars <= maxChars) continue;
    session.keys.push(key);
    session.day = localDateKey();
    const limit = String(maxChars).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");
    messages.push(`MEMORY.md är ${chars} tecken, taket är ${limit}. Lägg minnet i rätt index-*.md och lämna högst ett krokord här.`);
  }
  if (!messages.length) process.exit(0);

  state.sessions = { ...state.sessions, [sessionId]: session };
  writeState(state);
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: messages.join("\n") },
  })}\n`);
} catch (error) {
  quietExit(error.message);
}
