// The form of the day files of his messages (docs/DESIGN-search-daemon.md). Two files per UTC day:
//
//   YYYY-MM-DD.md         one bullet per message, in the order they were written:
//     - **05:39:58Z Mattias to api:0 voice** the words, word for word
//       continuation lines are indented two spaces, so the message stays one unit
//     With no name configured the header is `- **05:39:58Z api:0 voice** `.
//   YYYY-MM-DD.joined.md  one bullet per run of his messages to one pane, each 2 minutes or less after the one before:
//     - **07:07:54Z to 07:08:14Z Mattias to lsrc:0, 2 messages**
//       first message
//       second message, whose own later lines are indented two spaces more
//
// The joined file is derived from the first and is always rewritten whole. This module only reads and renders text;
// core/search-human-words.mjs does the writing.

import { repeatKeyOfText } from "./ask-origin.mjs";

/** WHAT: Defines the pattern of a day file or a joined file, capturing its day. WHY: Keeps deleting and rebuilding on one definition of what the folder holds. */
export const DAY_FILE = /^(\d{4}-\d{2}-\d{2})(?:\.joined)?\.md$/u;
/** WHAT: Names the file of one day's messages. WHY: Keeps the two file names, and so what search indexes, in one place. */
export const dayFileName = (day) => `${day}.md`;
/** WHAT: Names the file of one day's joined runs. WHY: Keeps the joined file's name from drifting away from the day file's. */
export const joinedFileName = (day) => `${day}.joined.md`;
/** WHAT: Returns the UTC day of a time. WHY: Keeps the file a message belongs to on one rule. */
export const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
/** WHAT: Returns the UTC clock HH:MM:SS of a time. WHY: Keeps the header and the removal of a bullet on one clock. */
export const clockOfMs = (ms) => new Date(ms).toISOString().slice(11, 19);

// The gap between one message and the next that still counts as the same breath, in seconds (design I-2b).
const JOIN_GAP_SECONDS = 120;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const whoIs = (name, address) => (name ? `${name} to ${address}` : address);
const secondsOf = (clock) => clock.split(":").reduce((total, part) => total * 60 + Number(part), 0);

/** WHAT: Formats one message as the bullet of its day file. WHY: Keeps a message one Markdown unit: indented later lines cannot start a bullet, heading or table row. */
export function bulletOf({ ts, agent, pane }, { text, spoken }, name) {
  const [first, ...rest] = text.split("\n");
  const lead = `- **${clockOfMs(Date.parse(ts))}Z ${whoIs(name, `${agent}:${pane}`)}${spoken ? " voice" : ""}** `;
  return `${lead}${[first, ...rest.map((line) => (line ? `  ${line}` : line))].join("\n")}\n`;
}

/** WHAT: Returns the first lines of a day file. WHY: Keeps a new file's heading in one place, written once. */
export const dayHeading = (day) => `# Human messages, ${day}\n\n`;

function parseBullet(raw, header) {
  const match = header.exec(raw);
  if (!match) return { raw };
  const [lead, clock, address, voice] = match;
  const [first, ...rest] = raw.slice(lead.length).replace(/\n$/u, "").split("\n");
  // The inverse of bulletOf: the two-space indent of the later lines comes off, empty lines stay empty.
  return { raw, clock, address, spoken: Boolean(voice), text: [first, ...rest.map((line) => line.replace(/^ {2}/u, ""))].join("\n") };
}

/**
 * `bullets[i].raw` is the exact text of the bullet; the fields after it are missing for a bullet whose header is not
 * in this name's form, which the callers then leave alone. `head` is everything before the first bullet.
 * WHAT: Parses the text of a day file into its heading and its bullets.
 * WHY: Keeps the joined file and the removal of a repeated prompt on one reading of the file.
 */
export function parseDay(text, name) {
  const header = new RegExp(`^- \\*\\*(\\d{2}:\\d{2}:\\d{2})Z ${name ? `${escapeRegex(name)} to ` : ""}(\\S+:\\d+)( voice)?\\*\\* ?`, "u");
  const first = text.search(/^- \*\*/mu);
  if (first === -1) return { head: text, bullets: [] };
  return { head: text.slice(0, first), bullets: text.slice(first).split(/^(?=- \*\*)/mu).map((raw) => parseBullet(raw, header)) };
}

/** WHAT: Builds the text of a day file from a heading and bullets. WHY: Keeps the file ending in one newline after a bullet has been taken out. */
export function dayText(head, bullets) {
  const text = `${head}${bullets.map((bullet) => bullet.raw).join("")}`;
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** WHAT: Filters out the bullets of messages whose words are repeated prompts. WHY: Keeps a prompt from staying in the day files once it has turned out to be a loop. */
export function withoutRepeated(parsed, gone) {
  const bullets = parsed.bullets.filter((bullet) => {
    if (!bullet.clock) return true;
    const key = repeatKeyOfText(bullet.text);
    return !gone.some((entry) => entry.key === key && entry.clock === bullet.clock && entry.address === bullet.address);
  });
  return { head: parsed.head, bullets, changed: bullets.length !== parsed.bullets.length };
}

// Per pane, in time order, each message that came 2 minutes or less after the one before it joins its run; a run of one is not a run.
function runsOf(bullets) {
  const byPane = new Map();
  bullets.filter((bullet) => bullet.clock).forEach((bullet, order) => {
    const group = byPane.get(bullet.address) || [];
    group.push({ ...bullet, at: secondsOf(bullet.clock), order });
    byPane.set(bullet.address, group);
  });
  const runs = [];
  for (const messages of byPane.values()) {
    let run = [];
    for (const message of messages.sort((left, right) => left.at - right.at || left.order - right.order)) {
      if (run.length && message.at - run.at(-1).at > JOIN_GAP_SECONDS) { if (run.length > 1) runs.push(run); run = []; }
      run.push(message);
    }
    if (run.length > 1) runs.push(run);
  }
  return runs.sort((left, right) => left[0].at - right[0].at || left[0].address.localeCompare(right[0].address));
}

function joinedBullet(run, name) {
  const lines = run.flatMap((message) => message.text.split("\n").map((line, index) => (line ? `${index ? "    " : "  "}${line}` : line)));
  return `- **${run[0].clock}Z to ${run.at(-1).clock}Z ${whoIs(name, run[0].address)}, ${run.length} messages**\n${lines.join("\n")}\n`;
}

/**
 * WHAT: Builds one day's joined file from its bullets, or "" without a run of two.
 * WHY: Lets one thought that came in pieces be found as one unit, while the singles stay.
 */
export function joinedDayText(day, bullets, name) {
  const runs = runsOf(bullets);
  return runs.length ? `# Human messages joined, ${day}\n\n${runs.map((run) => joinedBullet(run, name)).join("")}` : "";
}
