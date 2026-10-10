#!/usr/bin/env node
/**
 * WHAT: Claude PostToolUse hook. When a write grows a section of today's or yesterday's daily memory note past the
 * section rule, it tells the writer once per section and session, in Swedish, how to shorten it.
 * WHY: Mattias 2026-10-10, "blir du påmind om dem när de behövs": the rule reached writers only through a nightly
 * lint report, and 31 sections over 15 lines piled up in two days. It never blocks: the write already happened.
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
  const { reminderKey, sectionReminderText, touchedSections, writtenDailyNotes } = await import("../core/memory-section-reminder.mjs");
  const { DEFAULT_MEMORY_POLICY, dateKeyDaysAgo, loadMemoryPolicy } = await import("../core/memory-policy.mjs");
  const notes = writtenDailyNotes(payload);
  if (!notes.length) process.exit(0);

  const state = readState();
  if (!state.sessions || typeof state.sessions !== "object") state.sessions = {};
  const yesterday = dateKeyDaysAgo(1);
  for (const [id, session] of Object.entries(state.sessions)) {
    if (!(session?.day >= yesterday)) delete state.sessions[id];
  }
  const sessionId = String(payload.session_id || "no-session");
  const session = state.sessions[sessionId] || { day: notes[0].dateKey, keys: [] };

  const messages = [];
  for (const note of notes) {
    let text;
    try { text = readFileSync(note.path, "utf8"); } catch { continue; }
    let maxLines = DEFAULT_MEMORY_POLICY.dailySectionMaxLines;
    try { maxLines = loadMemoryPolicy(dirname(dirname(note.path))).dailySectionMaxLines; } catch {
      // an invalid policy file is lint's to report; the default rule still applies here
    }
    const due = touchedSections(text, note.newStrings)
      .filter((section) => section.lines > maxLines && !session.keys.includes(reminderKey(note, section)));
    if (!due.length) continue;
    session.keys.push(...due.map((section) => reminderKey(note, section)));
    session.day = note.dateKey > session.day ? note.dateKey : session.day;
    messages.push(sectionReminderText(note.dateKey, due));
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
