// The search daemon's memory of the conversation log: which rows hold which word, and where each row's line sits in its
// file. The log has 300 000 rows in 30 days and a question used to read all of them; here a question looks its words up,
// reads the few lines it needs, and scores them as the scan in core/search-conversation.mjs does (the same code).
//
// A row keeps no text, only its place: the file's inode (a rotation renames the file, the inode stays), the byte offset
// and length of its line, its time and day, and the words it holds, in an index from word to row numbers. The log
// stays the only source. Used only inside the daemon; a caller without a daemon scans the log instead.

import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { coalesceAskLedger, defaultAskLedgerPath } from "./ask-ledger.mjs";
import { isHumanAsk } from "./ask-origin.mjs";
import { tailLedger } from "./ledger-tail.mjs";
import { scoreHit, searchTokens } from "./search.mjs";
import { CONVERSATION_WEIGHT, CONVERSATION_WINDOW_MS, conversationHit, rankConversationHits } from "./search-conversation.mjs";
import { authoredPromptText, isSystemNoiseDirective } from "./system-noise.mjs";

// tokenMatches counts a word that starts another as a match from four letters.
const MIN_PREFIX = 4;
const SORT_AT_LEAST = 2048;
const yieldToEventLoop = () => new Promise((resolve) => setImmediate(resolve));
const wordsHash = (text) => createHash("sha256").update(authoredPromptText(text)).digest("hex").slice(0, 16);

function lowerBound(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1; else high = middle;
  }
  return low;
}

// Reads rows by their place, keeping each file open until the search is over.
function lineReader(files) {
  const open = new Map();
  const row = ({ id, file, offset, length }) => {
    const path = files.get(file);
    if (!path) return null;
    try {
      if (!open.has(path)) open.set(path, openSync(path, "r"));
      const bytes = Buffer.alloc(length);
      let count = 0;
      while (count < length) {
        const read = readSync(open.get(path), bytes, count, length - count, offset + count);
        if (!read) break;
        count += read;
      }
      const parsed = JSON.parse(bytes.toString("utf8", 0, count));
      return parsed.id === id ? { ...parsed, ledgerPath: path } : null;
    } catch { return null; }
  };
  return { row, close: () => { for (const fd of open.values()) { try { closeSync(fd); } catch { /* already gone */ } } } };
}

/**
 * `refresh()` reads what was added since the last call; the first call reads the whole window, in slices, yielding
 * between them. `search(query, { max })` answers from the index with the hits `searchConversationLog` returns, and
 * reads only the lines it needs.
 * WHAT: Builds an in-memory word index over the last 30 days of the conversation log.
 * WHY: Keeps a warm question from scanning the whole log.
 */
export function createConversationWindow({ path = defaultAskLedgerPath(), now = Date.now, tail = tailLedger, sliceBytes } = {}) {
  let tailState;
  let files;
  let rows;
  let asks;
  let index;
  let words;
  let postings;
  let asksVersion;
  let coalesced;
  let humanAsks = 0;
  const reset = () => {
    tailState = {}; files = new Map(); rows = []; asks = []; index = new Map(); words = { sorted: [], fresh: [] };
    postings = 0; asksVersion = 0; coalesced = null;
  };
  reset();

  const addRow = ({ row, file, offset, length }) => {
    const ms = Date.parse(row.ts);
    const isAsk = row.event === "ask" && typeof row.verbatim === "string";
    if (!Number.isFinite(ms) || !(isAsk || (row.event === "post" && typeof row.text === "string"))) return;
    const text = isAsk ? row.verbatim : row.text;
    if (isAsk && isSystemNoiseDirective(text)) return;
    const number = rows.length;
    rows.push({ id: row.id, ms, date: String(row.ts).slice(0, 10), isAsk, file, offset, length });
    if (isAsk) {
      if (isHumanAsk(row)) humanAsks++;
      // The words stand in for the text, so coalescing pairs a delivery with its pane-hook copy without keeping any.
      asks.push({ number, id: row.id, ts: row.ts, source: row.source, agent: row.agent, pane: row.pane, verbatim: wordsHash(text) });
      asksVersion++;
    }
    for (const token of new Set(searchTokens(text))) {
      let holders = index.get(token);
      if (!holders) { holders = []; index.set(token, holders); words.fresh.push(token); }
      holders.push(number);
      postings++;
    }
  };

  let building = false;
  const pass = async () => {
    building = true;
    humanAsks = 0;
    try {
      for (let done = false; !done;) {
        const tailed = tail(tailState, { path, sinceMs: now() - CONVERSATION_WINDOW_MS, maxBytes: sliceBytes });
        // A file that got smaller was rewritten: offsets held for it mean nothing, so everything is read again.
        if (tailed.rewritten) { reset(); continue; }
        tailState = tailed.state;
        files = new Map(Object.entries(tailState).map(([key, entry]) => [key, entry.path]));
        for (const entry of tailed.rows) addRow(entry);
        done = tailed.done;
        if (!done) await yieldToEventLoop();
      }
      // The two derived lists a question needs are made here, in the background, not by the first question.
      sortedWords();
      askOrder(now() - CONVERSATION_WINDOW_MS);
      return { humanAsks };
    } finally { building = false; }
  };

  let queue = Promise.resolve();
  const sortedWords = () => {
    if (words.fresh.length > Math.max(SORT_AT_LEAST, words.sorted.length / 16)) {
      words.sorted = [...words.sorted, ...words.fresh].sort();
      words.fresh = [];
    }
    return words;
  };
  const wordsStartingWith = (prefix) => {
    const { sorted, fresh } = sortedWords();
    const found = fresh.filter((word) => word.startsWith(prefix));
    for (let at = lowerBound(sorted, prefix); at < sorted.length && sorted[at].startsWith(prefix); at++) found.push(sorted[at]);
    return found;
  };
  // The words tokenMatches accepts for one query word: itself, longer words that start with it, and shorter words of
  // four letters or more that it starts with.
  const wordsMatching = (word) => {
    const found = index.has(word) ? [word] : [];
    if (word.length < MIN_PREFIX) return found;
    for (const longer of wordsStartingWith(word)) if (longer !== word) found.push(longer);
    for (let length = MIN_PREFIX; length < word.length; length++) if (index.has(word.slice(0, length))) found.push(word.slice(0, length));
    return found;
  };
  const rowsHoldingAll = (queryWords) => {
    let all = null;
    for (const word of queryWords) {
      const holding = new Uint8Array(rows.length);
      for (const token of wordsMatching(word)) for (const number of index.get(token)) holding[number] = 1;
      if (all) for (let number = 0; number < holding.length; number++) all[number] &= holding[number];
      else all = holding;
    }
    return all;
  };

  // The asks as readWindow returns them: only those inside the window, each delivery standing for its copy. They are
  // coalesced again only when asks have arrived since.
  const askOrder = (sinceMs) => {
    if (coalesced?.version !== asksVersion) {
      const inside = asks.filter((ask) => rows[ask.number].ms > sinceMs);
      coalesced = { version: asksVersion, order: new Map(coalesceAskLedger(inside).map((ask, position) => [ask.number, position])) };
    }
    return coalesced.order;
  };

  return {
    /** WHAT: Reads the rows added to the log since the last call and counts the new messages of his. WHY: Keeps a message he wrote a minute ago in the answer without reading the log again. */
    refresh() {
      const run = queue.catch(() => {}).then(pass);
      queue = run;
      return run;
    },
    /** WHAT: Says whether the window is still reading. WHY: Keeps the daemon from exiting in the middle of its first build. */
    busy: () => building,
    /** WHAT: Counts what the window holds. WHY: Shows what a warm daemon pays in memory for the log. */
    stats: () => ({ rows: rows.length, asks: askOrder(now() - CONVERSATION_WINDOW_MS).size, words: index.size, postings }),
    /**
     * WHAT: Returns the hits `searchConversationLog` returns for the rows read so far.
     * WHY: Answers a question from memory. Rows are read newest day first and reading stops when no unread day can reach the top.
     */
    search(query, { max = 12 } = {}) {
      const nowMs = now();
      const queryWords = [...new Set(searchTokens(query))];
      if (!queryWords.length) return [];
      const sinceMs = nowMs - CONVERSATION_WINDOW_MS;
      const order = askOrder(sinceMs);
      const holding = rowsHoldingAll(queryWords);
      const days = new Map();
      for (let number = 0; number < rows.length; number++) {
        const row = rows[number];
        if (!holding[number] || !(row.ms > sinceMs) || (row.isAsk && !order.has(number))) continue;
        if (days.has(row.date)) days.get(row.date).push(number); else days.set(row.date, [number]);
      }
      // The best any row of a day can score is as an exact phrase, so a day that cannot beat the best `max` found is skipped.
      const bound = (date) => scoreHit({ weight: CONVERSATION_WEIGHT, layer: "L1", date, matches: queryWords.length }, nowMs);
      const reader = lineReader(files);
      const found = [];
      let linesRead = 0;
      try {
        for (const [date, numbers] of [...days].sort(([a], [b]) => bound(b) - bound(a) || b.localeCompare(a))) {
          if (found.length >= max && found.map((item) => item.hit.score).sort((a, b) => b - a)[max - 1] > bound(date)) break;
          for (const number of numbers) {
            linesRead++;
            const row = reader.row(rows[number]);
            const hit = row && conversationHit(row, { words: queryWords, query, nowMs });
            if (hit) found.push({ hit, number });
          }
        }
      } finally { reader.close(); }
      // Equal scores keep the order the scan visits rows in: asks as coalesced, then posts by time and id.
      found.sort((left, right) => {
        const [a, b] = [rows[left.number], rows[right.number]];
        if (a.isAsk !== b.isAsk) return a.isAsk ? -1 : 1;
        return a.isAsk ? order.get(left.number) - order.get(right.number) : a.ms - b.ms || String(a.id).localeCompare(String(b.id));
      });
      const ranked = rankConversationHits(found.map((item) => item.hit), max);
      // What the question cost, for a test or a measurement to read; it is not part of the answer.
      return Object.defineProperty(ranked, "cost", { value: { candidates: [...days.values()].reduce((sum, numbers) => sum + numbers.length, 0), linesRead } });
    },
  };
}
