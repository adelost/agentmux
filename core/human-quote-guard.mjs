// Refuses an agent-to-agent send that pastes Mattias's own words.
// He told the fleet many times since 17 Oct never to quote him in briefs, and on
// 19 Oct a lead still pasted him into 17 of them; a memory rule alone failed.
// His exact words with provenance belong in the decision log (the day file or
// PRIORITIES.md). Those files are not sends and stay free to hold them.

import { dirname, join } from "node:path";
import { defaultAskLedgerPath } from "./ask-ledger.mjs";
import { ledgerFiles, readScanCache, readWholeLinesFrom, writeScanCache } from "./ask-ledger-scan.mjs";

/** WHAT: Names the shortest run of his consecutive words that counts as a quote. WHY: Shorter runs are ordinary phrases. */
export const QUOTE_MIN_WORDS = 8;
/** WHAT: Names how far back his messages are compared. WHY: Keeps the check to what a brief can still be relaying. */
export const QUOTE_WINDOW_MS = 14 * 24 * 3_600_000;
const CACHE_VERSION = 1;

/** WHAT: Splits text into lowercase words of letters and digits, åäö kept. WHY: Case and punctuation must not hide a pasted quote. */
export const quoteWords = (text) => String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

// The bridge's own tags, links, paths and ids are not his words, and agents repeat them for good reasons.
const SYSTEM_TAG = /\[(?:transcribed voice|image attached|file attached|video attached|audio attached)[^\]]*\]/giu;
const notHisWords = (token) => /^(?:https?:\/\/|www\.)/iu.test(token) || /[/\\]/u.test(token)
  || /^[0-9a-f-]{16,}$/iu.test(token);

/** WHAT: Returns the words of one human message without system tags, links, paths or ids. WHY: Keeps a quote match on what he said. */
export function humanWordsOf(text) {
  return quoteWords(String(text || "").replace(SYSTEM_TAG, " ").split(/\s+/u)
    .filter((token) => token && !notHisWords(token)).join(" "));
}

/**
 * WHAT: Finds every run of at least minWords consecutive words a text shares with his messages, longest first.
 * WHY: Names all that the sender must rewrite, and where each run came from, in one refusal.
 */
export function findHumanQuotes(text, messages, { minWords = QUOTE_MIN_WORDS } = {}) {
  const sent = quoteWords(text);
  if (sent.length < minWords) return [];
  const starts = new Map();
  for (let index = 0; index + minWords <= sent.length; index++) {
    const gram = sent.slice(index, index + minWords).join(" ");
    starts.set(gram, [...(starts.get(gram) || []), index]);
  }
  const runs = [];
  const seen = new Set();
  for (const message of messages) {
    const words = humanWordsOf(message.text);
    const key = words.join(" ");
    if (words.length < minWords || seen.has(key)) continue;
    seen.add(key);
    for (let at = 0; at + minWords <= words.length; at++) {
      for (const from of starts.get(words.slice(at, at + minWords).join(" ")) || []) {
        let length = minWords;
        while (from + length < sent.length && at + length < words.length && sent[from + length] === words[at + length]) length++;
        runs.push({ from, length, message });
      }
    }
  }
  // Keep the longest run over each stretch of the sent text; the same words from a repeated message count once.
  const covered = new Array(sent.length).fill(false);
  return runs.sort((left, right) => right.length - left.length).flatMap((run) => {
    if (covered.slice(run.from, run.from + run.length).every(Boolean)) return [];
    covered.fill(true, run.from, run.from + run.length);
    return [{ words: sent.slice(run.from, run.from + run.length), message: run.message }];
  });
}

/** WHAT: Returns the longest quoted run, or null. WHY: Keeps a single-answer caller simple. */
export const findHumanQuote = (text, messages, options) => findHumanQuotes(text, messages, options)[0] || null;

// Most ledger lines are posts; only his Discord asks are parsed.
function humanAsksIn(chunk) {
  const messages = [];
  for (const line of chunk.split("\n")) {
    if (!line.includes("\"source\":\"discord\"") || !line.includes("\"event\":\"ask\"")) continue;
    try {
      const entry = JSON.parse(line);
      const ts = Date.parse(entry.ts);
      const text = entry.verbatim || entry.text;
      if (entry.event === "ask" && entry.source === "discord" && Number.isFinite(ts) && text) {
        messages.push({ ts, to: `${entry.agent}:${entry.pane}`, text: String(text) });
      }
    } catch { /* a torn last line is read again on the next send */ }
  }
  return messages;
}

/**
 * WHAT: Reads his Discord messages of the last two weeks from every ask ledger, through an offset cache.
 * WHY: Keeps a send from parsing hundreds of megabytes; rotated files are read once, the live one incrementally.
 */
export function readRecentHumanMessages({
  ledgerPath = defaultAskLedgerPath(),
  cachePath = join(dirname(ledgerPath), "quote-guard", "human-messages.json"),
  now = Date.now(),
  windowMs = QUOTE_WINDOW_MS,
} = {}) {
  const since = now - windowMs;
  const cache = readScanCache(cachePath, CACHE_VERSION);
  const next = { version: CACHE_VERSION, files: {} };
  let changed = false;
  for (const file of ledgerFiles(ledgerPath).filter((candidate) => candidate.mtimeMs >= since)) {
    const prior = cache.files[file.path];
    const reusable = prior && prior.ino === file.ino && prior.offset <= file.size;
    const read = reusable && prior.offset === file.size ? null : readWholeLinesFrom(file, reusable ? prior.offset : 0);
    const messages = [...(reusable ? prior.messages : []), ...(read ? humanAsksIn(read.text) : [])]
      .filter((message) => message.ts >= since);
    next.files[file.path] = { ino: file.ino, offset: read ? read.offset : prior.offset, messages };
    changed ||= !reusable || Boolean(read?.text) || messages.length !== prior.messages.length;
  }
  if (changed || Object.keys(next.files).length !== Object.keys(cache.files).length) writeScanCache(cachePath, next);
  return Object.values(next.files).flatMap((entry) => entry.messages).filter((message) => message.ts <= now);
}

const clock = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** WHAT: Words the refusal for a send that quotes him. WHY: Names every run to rewrite and where his exact words go instead. */
export function humanQuoteRefusal(matches) {
  const runs = matches.map((match) => `- "${match.words.join(" ")}" (${match.words.length} words, his message to`
    + ` ${match.message.to}, ${clock(match.message.ts)}Z)`);
  return ["amux: refused. This message pastes Mattias's own words:", ...runs,
    "Rewrite them as instructions in your own words and point to the decision log entry. His exact words belong"
      + " in the decision log (the day file or PRIORITIES.md), never in a send."].join("\n");
}

/**
 * WHAT: Returns the refusal for an agent send that quotes his recent messages, or null.
 * WHY: One mechanical check on the agent-to-agent path instead of a rule agents forget.
 */
export function refuseHumanQuote(text, {
  enabled = process.env.AMUX_QUOTE_GUARD_ENABLED !== "false",
  messages = () => readRecentHumanMessages(),
} = {}) {
  if (!enabled) return null;
  const matches = findHumanQuotes(text, messages());
  return matches.length ? humanQuoteRefusal(matches) : null;
}
