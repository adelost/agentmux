// A synthetic conversation log, for the tests of the search daemon's reader (docs/DESIGN-search-daemon.md, chapter 12).
// The tail, the day files of his messages and the daemon's window all read this one fixture, so the three see the
// same log.
//
// Rows are written by the real writers in core/ask-ledger.mjs, so they have the real shape. The log keeps the hazards
// of the real one: a rotation renames the live file and keeps its inode under the new path, a row can be half written
// when a reader looks (here cut inside a two-byte letter), and one delivery is followed by its pane-hook copy.
// Nothing here touches the real log or the real home.

import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { appendAskLedger, appendPost } from "../../core/ask-ledger.mjs";

/** The moment every test reads the log at. */
export const NOW_MS = Date.parse("2026-10-20T12:00:00.000Z");
/** The bridge's own tag in front of a transcribed voice message. */
export const VOICE_PREFIX = "[transcribed voice, may contain speech-to-text errors; interpret intent] ";

const QUARTER_LINES = [
  "Kvartalsrapport för styrgruppen, version två.",
  "",
  "- punkt ett: budgeten håller",
  "- punkt två: prognosen skärps",
  "# Rubrik som inte får bli ett eget stycke",
  "| kolumn a | kolumn b |",
  "**Fet inledning** — brödtext efter tankstreck",
  "    indenterad kodrad med åäö",
];
const FILLER_LINE = "Kvartalsrapporten ska innehålla budget, utfall och prognos för nästa period.";
/** A message of 2 000 characters whose lines look like list items, a heading and a table row when read as Markdown. */
export const LONG_MESSAGE = `${[...QUARTER_LINES, "", ...Array(40).fill(FILLER_LINE)].join("\n").slice(0, 1999)}.`;

/** The messages of the log, by the name the tests use. Times are UTC; `source` is who delivered the row, discord unless said. */
export const MESSAGES = Object.freeze({
  beforeWindow: { id: "ask:old", ts: "2026-09-05T08:00:00.000Z", agent: "lsrc", pane: 0,
    text: "Gamla beslutet om autocompact fattades i september" },
  inWindowFirst: { id: "ask:a3", ts: "2026-09-24T10:00:00.000Z", agent: "lsrc", pane: 0,
    text: "Kom ihåg att autocompact-gränsen ska vara sjuttio procent" },
  delivery: { id: "delivery:b1", ts: "2026-10-05T05:39:58.000Z", agent: "api", pane: 0,
    text: "Okej, ja men vi kör Sonnet för genomförandet och Opus planerar" },
  hookCopy: { id: "hook:b1", ts: "2026-10-05T05:40:02.000Z", agent: "api", pane: 0, source: "pane-hook",
    text: "Okej, ja men vi kör Sonnet för genomförandet och Opus planerar" },
  brief: { id: "brief:b3", ts: "2026-10-05T06:00:00.000Z", agent: "api", pane: 0, sender: "claw:1", source: "amux-send",
    text: "[from claw:1] Kolla autocompact-statusen i lsrc:0 och rapportera" },
  notification: { id: "note:b4", ts: "2026-10-05T06:10:00.000Z", agent: "api", pane: 0, source: "pane-hook",
    text: "<task-notification>\n<task-id>t1</task-id>\n<summary>autocompact-körningen klar</summary>\n</task-notification>" },
  voice: { id: "voice:b5", ts: "2026-10-06T07:15:03.000Z", agent: "api", pane: 1,
    text: `${VOICE_PREFIX}Hej, vi behöver autocompact-gränsen dokumenterad` },
  long: { id: "long:b7", ts: "2026-10-07T09:00:00.000Z", agent: "api", pane: 2, text: LONG_MESSAGE },
  typed: { id: "typed:c1", ts: "2026-10-19T14:30:00.000Z", agent: "lsrc", pane: 1, source: "pane-hook",
    text: "Kör testerna för autocompact nu" },
  question: { id: "ask:c3", ts: "2026-10-20T08:00:00.000Z", agent: "api", pane: 0,
    text: "Vad sa vi om Sonnet och Opus?" },
  late: { id: "ask:c4", ts: "2026-10-20T11:59:00.000Z", agent: "api", pane: 0,
    text: "Sista meddelandet om autocompact före åäö-gränsen" },
});

/**
 * Creates an empty log in its own directory. `ask`, `post`, `rotate` and `partial` make it grow the way the bridge
 * does; `remove` deletes the directory.
 */
export function createLog() {
  const dir = mkdtempSync(join(tmpdir(), "conversation-log-"));
  const path = join(dir, "ask-ledger.jsonl");
  const writerOptions = { path, maxBytes: Number.MAX_SAFE_INTEGER };

  const log = {
    dir,
    path,
    /** Appends one ask row. `message` is one of MESSAGES, or the same shape. */
    ask(message) {
      return appendAskLedger({ id: message.id, ts: message.ts, agent: message.agent, pane: message.pane,
        source: message.source || "discord", sender: message.sender, verbatim: message.text }, writerOptions);
    },
    /** Appends one posted answer. */
    post(entry) {
      return appendPost({ channelId: "channel", via: "bridge", kind: "reply", ...entry, payload: entry.text }, writerOptions);
    },
    /** Renames the live file to an archive. The file keeps its inode; the next row starts a new live file. */
    rotate(at) {
      const stamp = new Date(at).toISOString().replace(/[:.]/gu, "-");
      const archive = join(dir, `${basename(path, ".jsonl")}.${stamp}.${process.pid}.${randomUUID()}.jsonl`);
      renameSync(path, archive);
      return archive;
    },
    /**
     * Appends one ask row but leaves its last bytes unwritten, cut inside the first letter that takes two bytes.
     * `finish()` writes the rest. This is what a reader sees when it looks between the pieces of one write.
     */
    partial(message) {
      log.ask(message);
      const bytes = readFileSync(path);
      const text = bytes.toString("utf8");
      const lineStart = text.lastIndexOf("\n", text.length - 2) + 1;
      const twoByte = bytes.indexOf(Buffer.from("å"), Buffer.byteLength(text.slice(0, lineStart)));
      const cut = twoByte === -1 ? bytes.length - 12 : twoByte + 1;
      const rest = bytes.subarray(cut);
      writeFileSync(path, bytes.subarray(0, cut));
      return { finish: () => appendFileSync(path, rest) };
    },
    /** Replaces the live file by a shorter one with the same inode, as a truncating rewrite does. */
    rewrite(rows) {
      writeFileSync(path, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
    },
    remove() { rmSync(dir, { recursive: true, force: true }); },
  };
  return log;
}

/**
 * Builds the log of the design's chapter 12: three files, the oldest archive first.
 * Archive A holds a message before the 30-day window and one inside it. Archive B was the live file once, and holds a
 * delivery with its pane-hook copy, an agent's brief, a task notification, a voice message and the long message.
 * The live file ends in a half-written row, which `unfinished.finish()` completes.
 */
export function createThreeFileLog() {
  const log = createLog();
  log.ask(MESSAGES.beforeWindow);
  log.post({ agent: "lsrc", pane: 0, ts: "2026-09-05T08:01:00.000Z", text: "Noterat, autocompact stängs av i september.", messageId: "m-a2" });
  log.ask(MESSAGES.inWindowFirst);
  log.post({ agent: "lsrc", pane: 0, ts: "2026-09-24T10:00:30.000Z", text: "Gränsen för autocompact sätts till sjuttio procent.", messageId: "m-a4" });
  log.archiveA = log.rotate("2026-10-02T06:00:00.000Z");

  log.ask(MESSAGES.delivery);
  log.ask(MESSAGES.hookCopy);
  log.post({ agent: "api", pane: 0, ts: "2026-10-05T05:41:00.000Z", text: "Jag kör Sonnet för genomförandet enligt planen.", messageId: "m-b6" });
  log.ask(MESSAGES.brief);
  log.ask(MESSAGES.notification);
  log.ask(MESSAGES.voice);
  log.ask(MESSAGES.long);
  log.archiveB = log.rotate("2026-10-12T10:00:00.000Z");

  log.ask(MESSAGES.typed);
  log.post({ agent: "lsrc", pane: 1, ts: "2026-10-19T14:31:00.000Z", text: "Testerna för autocompact är gröna", messageId: "m-c2" });
  log.ask(MESSAGES.question);
  log.unfinished = log.partial(MESSAGES.late);
  return log;
}

/** Makes a directory for the day files of his messages, next to nothing real. */
export function createHumanDir() {
  const dir = mkdtempSync(join(tmpdir(), "search-human-"));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
