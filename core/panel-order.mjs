// The order at the send: a warning, never a stop (Mattias in plan:3's channel 16 Nov 10:18Z, delivery:5e280cd187079eb9c30b2e53d057ae2b,
// and 16 Nov about 17:35Z, delivery:7b48c6f1008fcd8a454370e06d03777d and delivery:63334e34297fc9388941cddb21492052; deep:5 the same hour).
// A pane can always send. A send outside the order is delivered, the sender is told at once which rule it passed and what the protocol is,
// the receiver sees AMUX's mark ahead of the text, and the send is logged so the pass or the rule can be judged afterwards.
// Outside the order is for emergencies: `--anyway "reason"` states the reason and decides nothing. Pure: the caller reads the guard file and logs.
// `guard` is what the runner writes each minute: { at, pilot: [panes], leads: [panes], over: { row: messages }, limit }.
// deep:5's conditions, 16 Nov 10:2xZ: only the pilot's senders are ever marked; a decider's or a lead's own send never is;
// a year, a clock or a number with a unit is not a row; `--anyway` needs its reason.
const MIN = 60_000;
const MARK_MAX = 160;
const HEADER = /^\[from [^\]]+\]\s*/;
const MONTH = '(?:jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)[a-z]*';
const ROW = new RegExp(`(?<![\\d:.\\-/]|${MONTH}\\s)\\b(\\d{4}(?:-[a-z][\\w-]*|[a-z])?)\\b(?!-\\d\\d|:\\d\\d|[.,]\\d|\\s?(?:px|ms|s|h|min|%|k|kb|mb|gb|usd|kr|lines|files|tokens|rows|runs|commits)\\b)`, 'gi');
/** WHAT: Checks row identifiers in message text. WHY: Keeps dates and measurements out of row decisions. */
export const rowsIn = text => [...text.matchAll(ROW)].map(match => ({ id: match[1], at: match.index }));

/** WHAT: Checks whether a pilot send goes outside the order. WHY: Keeps the sender, the receiver and the log told while the send still goes. */
export function orderNotice({ sender, target, text, guard, anyway = null, now = Date.now() }) {
  if (anyway !== null && (typeof anyway !== 'string' || !anyway.trim() || anyway.length > 1000 || anyway.startsWith('--')))
    throw new Error('--anyway requires a non-empty reason (at most 1000 characters)');
  // No guard file, or one the runner has not rewritten for 10 minutes: no guard. A dead runner must not mark the fleet's messages.
  if (!guard || now - guard.at > 10 * MIN) return null;
  if (!sender || sender === target || !guard.pilot.includes(sender) || guard.leads.includes(sender) || /^(deep|plan):/.test(sender)) return null;
  const body = text.replace(HEADER, '').trimStart();
  const first = rowsIn(body.slice(0, 90))[0];
  const word = first && first.at <= 3 && /^.{0,40}?\b(DONE|BLOCKED|KLAR|STOPP)\b/i.exec(body.slice(first.at + first.id.length, 90))?.[1];
  if (word && guard.leads.includes(target)) {
    const stop = /BLOCKED|STOPP/i.test(word), words = `${first.id} ${stop ? 'blocked' : 'done'} belongs in the ticket`;
    return { rule: 'ticket', row: first.id, count: null, limit: null, words,
      told: `${words}, not in a message to ${target}: \`ticket ${stop ? `blocked ${first.id} --needs "what must happen"` : `done ${first.id} --proof SHA`}\`. ${target} reads it there.` };
  }
  // Talk without progress: the row has drawn more messages than the limit since its last landed commit. A planner may still be written to.
  const row = rowsIn(body.slice(0, 200)).map(found => found.id).find(id => guard.over?.[id]);
  if (row && !/^(deep|plan):/.test(target)) {
    const count = guard.over[row], limit = guard.limit;
    return { rule: 'talk', row, count, limit, words: `row ${row} has drawn ${count} messages, limit ${limit}`,
      told: `row ${row} has drawn ${count} messages since its last landed commit (limit ${limit}). Read the code and write \`ticket cause ${row} --at FILE:LINE\`, or write to its planner.` };
  }
  return null;
}

/** WHAT: Returns AMUX's mark for a send outside the order. WHY: Keeps the rule whole and the sender's reason inside AMUX's own brackets on one line. */
export function orderMark(notice, reason = null) {
  const head = `[outside the order: ${notice.words}`;
  if (reason === null) return `${head}]`;
  // Brackets and line breaks in the reason would end AMUX's mark early, so the receiver could not tell it from the sender's words.
  const said = reason.replace(/\s+/g, ' ').trim().replace(/\[/g, '(').replace(/\]/g, ')'), room = Math.max(MARK_MAX - head.length - '; reason: ]'.length, 1);
  return `${head}; reason: ${said.length > room ? `${said.slice(0, room - 1).trimEnd()}…` : said}]`;
}

/** WHAT: Returns the pane text with AMUX's marks ahead of the message. WHY: Keeps the sender header first, where readers expect it, and a raw slash command a command. */
export function markedPaneText(text, marks) {
  const header = HEADER.exec(text)?.[0];
  return header && marks.length ? `${header.trimEnd()}\n${marks.join('\n')}\n\n${text.slice(header.length)}` : text;
}

/** WHAT: Returns the sender's lines for a send outside the order. WHY: Keeps the sender told the rule and the protocol on the send's own output. */
export function senderLines(notice, { reason = null, flag, marked, went }) {
  return [`Outside the order: ${notice.told}`,
    `${went} ${marked ? 'with AMUX\'s mark ahead of your text' : 'unmarked, as a slash command'}, and logged ${reason === null ? `without a reason (give one with ${flag} "reason")` : 'with your reason'}. Outside the order is for emergencies.`];
}
