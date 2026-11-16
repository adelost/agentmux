// The guard at the send (Mattias in plan:3's channel 16 Nov 10:18Z, delivery:5e280cd187079eb9c30b2e53d057ae2b): panes may still write to
// each other, but a send that breaks the order is stopped before it is queued and told what to do instead. A hard recommendation:
// `--anyway "reason"` sends it, and the reason is logged. Pure: the caller reads the guard file and does the logging.
// `guard` is what the runner writes each minute: { at, pilot: [panes], leads: [panes], over: { row: messages }, limit }.
// deep:5's conditions, 16 Nov 10:2xZ: only the pilot's senders are ever stopped; a decider's or a lead's own send never is;
// a year, a clock or a number with a unit is not a row; `--anyway` needs its reason.
const MIN = 60_000;
const MONTH = '(?:jan|feb|mar|apr|maj|may|jun|jul|aug|sep|okt|oct|nov|dec)[a-z]*';
const ROW = new RegExp(`(?<![\\d:.\\-/]|${MONTH}\\s)\\b(\\d{4}(?:-[a-z][\\w-]*|[a-z])?)\\b(?!-\\d\\d|:\\d\\d|[.,]\\d|\\s?(?:px|ms|s|h|min|%|k|kb|mb|gb|usd|kr|lines|files|tokens|rows|runs|commits)\\b)`, 'gi');
/** WHAT: Checks row identifiers in message text. WHY: Keeps dates and measurements out of row decisions. */
export const rowsIn = text => [...text.matchAll(ROW)].map(match => ({ id: match[1], at: match.index }));

/** WHAT: Checks whether a pilot send breaks the order. WHY: Keeps the recommendation ahead of enqueue. */
export function orderRefusal({ sender, target, text, guard, anyway = null, now = Date.now() }) {
  if (anyway !== null && (typeof anyway !== 'string' || !anyway.trim() || anyway.length > 1000 || anyway.startsWith('--')))
    return '--anyway requires a non-empty reason (at most 1000 characters)';
  // No guard file, or one the runner has not rewritten for 10 minutes: no guard. A dead runner must not hold the fleet's messages.
  if (!guard || now - guard.at > 10 * MIN || anyway !== null) return null;
  if (!sender || sender === target || !guard.pilot.includes(sender) || guard.leads.includes(sender) || /^(deep|plan):/.test(sender)) return null;
  const body = text.replace(/^\[from [^\]]+\]\s*/, '').trimStart();
  const first = rowsIn(body.slice(0, 90))[0];
  const word = first && first.at <= 3 && /^.{0,40}?\b(DONE|BLOCKED|KLAR|STOPP)\b/i.exec(body.slice(first.at + first.id.length, 90))?.[1];
  if (word && guard.leads.includes(target)) {
    const stop = /BLOCKED|STOPP/i.test(word);
    return `Not sent: ${first.id} ${stop ? 'blocked' : 'done'} goes in the ticket, not to ${target}: \`ticket ${stop ? `blocked ${first.id} --needs "what must happen"` : `done ${first.id} --proof SHA`}\`. ${target} reads it there. In an emergency: --anyway "reason".`;
  }
  // Talk without progress: the row has drawn more messages than the limit since its last landed commit. A planner may still be written to.
  const row = rowsIn(body.slice(0, 200)).map(found => found.id).find(id => guard.over?.[id]);
  if (row && !/^(deep|plan):/.test(target))
    return `Not sent: row ${row} has drawn ${guard.over[row]} messages since its last landed commit (limit ${guard.limit}). Read the code and write \`ticket cause ${row} --at FILE:LINE\`, or write to its planner. In an emergency: --anyway "reason".`;
  return null;
}
