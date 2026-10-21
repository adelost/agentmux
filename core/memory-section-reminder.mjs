// Write-time reminder of the daily memory section rule.
//
// Writers are told "Max cirka 10 rader per manuell sektion" (generated
// .agents/CLAUDE.md, Minnesloggning), yet 2026-10-09/10 alone held 31 sections
// over 15 lines. Lint names them, but nobody reads a lint report while writing.
// The Claude PostToolUse hook asks this module whether the call just grew a
// section of today's or yesterday's note past the rule, once per section.

import { basename, dirname, isAbsolute, resolve } from "node:path";
import { dailySections, sectionAtLine } from "./daily-sections.mjs";
import { dateKeyDaysAgo, localDateKey } from "./memory-policy.mjs";

const DAILY_NAME_RE = /^(\d{4}-\d{2}-\d{2})\.md$/u;
// A shell path naming a daily note or a Claude project memory index.
const COMMAND_PATH_RE = /[^\s'"=(<>|;&`]*memory\/(?:\d{4}-\d{2}-\d{2}|MEMORY)\.md/gu;

/** WHAT: Expands the home forms a shell command uses. WHY: Keeps `~/…` and `$HOME/…` from hiding the file the hook must read. */
function expandHome(token, home) {
  if (token.startsWith("~/")) return `${home}${token.slice(1)}`;
  return token.replace(/^\$\{?HOME\}?(?=\/)/u, home);
}

/** WHAT: Returns the date of a daily note path, or null. WHY: Keeps archived copies and references out; only `memory/YYYY-MM-DD.md` is a daily note. */
function dailyDateKey(path) {
  const match = basename(path).match(DAILY_NAME_RE);
  return match && basename(dirname(path)) === "memory" ? match[1] : null;
}

/** WHAT: Resolves written memory paths from supported tools. WHY: Daily notes and project indexes share path identity and home expansion. */
function writtenMemoryFiles(payload, { home = process.env.HOME || "" } = {}) {
  const input = payload?.tool_input || {};
  const cwd = payload?.cwd || process.cwd();
  const notes = [];
  const add = (rawPath, newStrings) => {
    if (!rawPath) return;
    const expanded = expandHome(String(rawPath), home);
    const path = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    if (basename(dirname(path)) === "memory" && !notes.some((note) => note.path === path)) {
      notes.push({ path, newStrings });
    }
  };
  switch (payload?.tool_name) {
    case "Edit": add(input.file_path, [input.new_string]); break;
    case "MultiEdit": add(input.file_path, (input.edits || []).map((edit) => edit?.new_string)); break;
    case "Write": add(input.file_path, null); break;
    case "Bash": for (const token of String(input.command || "").match(COMMAND_PATH_RE) || []) add(token, null); break;
    default: break;
  }
  return notes;
}

/** WHAT: Extracts writes to today's or yesterday's note. WHY: Keeps old daily notes out of write-time reminders. */
export function writtenDailyNotes(payload, { now = new Date(), ...options } = {}) {
  const recent = new Set([localDateKey(now), dateKeyDaysAgo(1, now)]);
  return writtenMemoryFiles(payload, options)
    .map((note) => ({ ...note, dateKey: dailyDateKey(note.path) }))
    .filter((note) => recent.has(note.dateKey));
}

/** WHAT: Extracts writes to project memory indexes. WHY: Keeps size reminders bound to the file the tool wrote. */
export function writtenMemoryIndexes(payload, options) {
  return writtenMemoryFiles(payload, options).filter((note) => basename(note.path) === "MEMORY.md");
}

/**
 * WHAT: Resolves the sections a write touched: an edit's own, else the last one (an append).
 * WHY: Keeps the reminder on the section its writer just grew instead of another pane's older one.
 */
export function touchedSections(text, newStrings) {
  const sections = dailySections(text);
  if (!newStrings) return sections.length ? [sections.at(-1)] : [];
  const touched = [];
  for (const fragment of newStrings) {
    const anchor = String(fragment || "").split(/\r?\n/u).find((line) => line.trim());
    const offset = anchor ? text.indexOf(anchor) : -1;
    if (offset < 0) continue;
    const section = sectionAtLine(sections, text.slice(0, offset).split(/\r?\n/u).length - 1);
    if (section && !touched.includes(section)) touched.push(section);
  }
  return touched;
}

/** WHAT: Formats the reminder for the writer. WHY: Keeps it to one instruction the writer can act on in the same turn. */
export function sectionReminderText(dateKey, sections) {
  const named = sections.map((section) => `"${section.heading}" (${section.lines} rader)`).join(", ");
  return `Minnesregeln: ${named} i memory/${dateKey}.md är längre än en sektion får vara. `
    + "Håll en sektion till ungefär 10 rader och flytta detaljer till memory/references/<ämne>.md med en länk från sektionen.";
}

/** WHAT: Names one reminder by note and heading. WHY: Keeps a growing section from being named twice in a session. */
export const reminderKey = (note, section) => `${note.path}#${section.heading}`;
