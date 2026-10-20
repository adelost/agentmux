// Tells why a pane went quiet, from its turn-final reply alone: a quota park, his hands, a decision the delegate can
// make, work left, done, or nothing clear (docs/DESIGN-quiet-panes.md, chapter 6). Pure rules, no model, no clock, no
// file. An unclear reply sleeps: a wrong nudge costs more than a late one.

import { looksDone } from "./orchestrator-checkpoint.mjs";
import { operatorName } from "./runtime-defaults.mjs";

/** WHAT: Names the classes a quiet pane can have, in the order they are decided. WHY: Keeps the replay's counts and the tests on one list. */
export const QUIET_CLASSES = Object.freeze(["quota", "hands", "decision", "left", "done", "unclear"]);

// The end of a reply is where the pane says what it waits for, so a hands or decision word only counts on a waiting
// line or in the last 600 characters.
const TAIL_CHARS = 600;

const WAITING_LINE = [/väntar\s+på/iu, /\bBLOCKED:/u, /ja\s+eller\s+nej/iu, /\bditt\s+ja\b/iu, /beslut\s+för/iu, /your\s+decision/iu];

// What only he can do: a login, a payment card, a key, hardware, a test of his own.
const HANDS = Object.freeze([
  ["login", [/logga\s+in\b/iu, /inloggning/iu, /\blogin\b/iu, /lösenord/iu, /\b2fa\b/iu, /sms-?kod/iu]],
  ["payment", [/betalkort/iu, /\bcard\b/iu, /payment\s+method/iu]],
  ["key", [/api-?nyckel/iu, /\bapi\s+key\b/iu]],
  ["hardware", [/hårdvara/iu, /\bhardware\b/iu, /din\s+telefon/iu, /koppla\s+in\b/iu]],
  ["test", [/i\s+din\s+webbläsare/iu, /ditt\s+eget\s+test/iu, /testa\s+själv/iu]],
]);

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// What the delegate can answer without him. The configured operator's name stands where the design says his name.
const decisionWords = (operator) => [
  /väntar\s+på\s+(?:dig|ditt|din)\b/iu, new RegExp(`väntar\\s+på\\s+${escaped(operator)}`, "iu"),
  /\bditt\s+ja\b/iu, /ja\s+eller\s+nej/iu, /\bja\/nej\b/iu, new RegExp(`beslut\\s+för\\s+${escaped(operator)}`, "iu"),
  /needs\s+your\s+(?:yes|decision)/iu, /waiting\s+on\s+you\b/iu,
];

const BLOCKER = [/\bBLOCKED:/u, /väntar\s+på/iu, /blocked\s+by/iu];
const NOTHING = /^(?:none|nothing|inget|ingenting|ingen|n\/a|-|–)\.?$/iu;

/** WHAT: Normalizes a pane's line for quoting: no list marker, emphasis marks or runs of spaces. WHY: Keeps the quote readable in another pane. */
export function plainLine(line) {
  return String(line ?? "").replace(/^[\s>]*(?:[-*•]|\d+[.)])\s+/u, "").replace(/\*\*|__|`/gu, "").replace(/\s+/gu, " ").trim();
}

/** WHAT: Normalizes a waiting line to its words, lower case. WHY: Keeps the same line in later replies on one episode key whatever the markdown around it. */
export function normalizedLine(line) {
  return plainLine(line).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/gu, " ").trim();
}

// The lines that can decide the class: every line that says what the pane waits for, and the lines of the last 600 characters.
function waitingLines(reply) {
  const lines = reply.split("\n");
  const tailStart = Math.max(0, reply.length - TAIL_CHARS);
  const chosen = [];
  let offset = 0;
  for (const line of lines) {
    if (offset + line.length > tailStart || WAITING_LINE.some((word) => word.test(line))) chosen.push(line);
    offset += line.length + 1;
  }
  return chosen;
}

const lastLineMatching = (lines, words) => lines.findLast((line) => words.some((word) => word.test(line))) ?? null;

function handsIn(lines) {
  const line = lastLineMatching(lines, HANDS.flatMap(([, words]) => words));
  if (!line) return null;
  const [what] = HANDS.find(([, words]) => words.some((word) => word.test(line)));
  return { line, what };
}

// `LEFT: text` on its own line, with or without bold marks; an empty label takes the next line that has text.
function labelValue(reply, label) {
  const lines = reply.split("\n");
  const own = new RegExp(`^[\\s>*_\`#-]*${label}:[*_]*\\s*(.*)$`, "u");
  const index = lines.findLastIndex((line) => own.test(line));
  if (index < 0) return null;
  const value = plainLine(own.exec(lines[index])[1]);
  const next = lines.slice(index + 1).find((line) => line.trim()) ?? "";
  return value || (/^[\s>*_]*[A-Z]{3,}:/u.test(next) ? "" : plainLine(next));
}

const isNothing = (value) => !value || NOTHING.test(value);

function leftWork(reply) {
  const value = labelValue(reply, "LEFT");
  if (isNothing(value) || BLOCKER.some((word) => word.test(reply))) return null;
  return `LEFT: ${value}`;
}

function isDone(reply) {
  const open = labelValue(reply, "OPEN");
  return labelValue(reply, "DONE") !== null || (open !== null && isNothing(open)) || looksDone(reply);
}

const verdict = (cls, line = null, what = null) => ({ class: cls, line, what });

/**
 * `line` is the pane's own line that decided the class, ready to quote; `what` says which kind of hands (login, payment,
 * key, hardware, test). A parked pane is quota whatever it says, and his hands win over a decision.
 * WHAT: Maps a pane's turn-final reply to the reason it went quiet.
 * WHY: Keeps the rules for his hands, decisions and left work in one pure place.
 */
export function classifyQuiet(reply, { parked = false, operator = operatorName() } = {}) {
  if (parked) return verdict("quota");
  const text = String(reply ?? "");
  const lines = waitingLines(text);
  const hands = handsIn(lines);
  if (hands) return verdict("hands", plainLine(hands.line), hands.what);
  const decision = lastLineMatching(lines, decisionWords(operator));
  if (decision) return verdict("decision", plainLine(decision));
  const left = leftWork(text);
  if (left) return verdict("left", left);
  return isDone(text) ? verdict("done") : verdict("unclear");
}
