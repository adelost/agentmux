// Relative time in a question ("i går", "i förmiddags", "last week") names
// which daily notes it is about. Those words never occur in the answer, so
// they are removed from matching and turned into a date preference instead.

const DAY_MS = 86_400_000;

// Longest phrases first so "i går kväll" is not read as "i går" + "kväll".
const PHRASES = [
  [/\b(?:i förrgår|förrgår|day before yesterday)\b/giu, [2]],
  [/\b(?:i går kväll|igår kväll|i går morse|igår morse|i går|igår|yesterday|last night)\b/giu, [1]],
  [/\b(?:i natt|inatt|natten)\b/giu, [0, 1]],
  [/\b(?:i dag|idag|today|i förmiddags|i morse|imorse|i eftermiddag|i kväll|ikväll|tonight|this morning|this afternoon)\b/giu, [0]],
  [/\b(?:förra veckan|last week)\b/giu, "previous-week"],
  [/\b(?:den här veckan|denna vecka|i veckan|this week)\b/giu, "this-week"],
  [/\b(?:senaste veckan|past week)\b/giu, [0, 1, 2, 3, 4, 5, 6]],
];

const isoDay = (date) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
};

function weekOffsets(now, previous) {
  const weekday = (now.getDay() + 6) % 7; // Monday = 0
  const start = previous ? weekday + 7 : weekday;
  const end = previous ? weekday + 1 : 0;
  const offsets = [];
  for (let offset = start; offset >= end; offset--) offsets.push(offset);
  return offsets;
}

/**
 * WHAT: Extracts relative-time words and the local dates they name.
 * WHY: Keeps "i går" from being matched as content while still preferring that day's notes.
 */
export function temporalIntent(query, now = new Date()) {
  let text = String(query);
  const offsets = new Set();
  for (const [pattern, days] of PHRASES) {
    text = text.replace(pattern, () => {
      const list = days === "previous-week" ? weekOffsets(now, true) : days === "this-week" ? weekOffsets(now, false) : days;
      for (const offset of list) offsets.add(offset);
      return " ";
    });
  }
  const dates = [...offsets].sort((a, b) => a - b).map((offset) => isoDay(new Date(now.getTime() - offset * DAY_MS)));
  return { query: text.replace(/\s+/gu, " ").trim() || String(query), dates };
}

/** WHAT: Returns hits from the named dates first, keeping each group's order. WHY: Keeps an explicit "i går" from losing to a better-worded older note. */
export function preferDates(hits, dates) {
  if (!dates?.length) return hits;
  const wanted = new Set(dates);
  return [...hits.filter((hit) => wanted.has(hit.date)), ...hits.filter((hit) => !wanted.has(hit.date))];
}
