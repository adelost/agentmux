// A question for his words lists his own search units first (docs/DESIGN-search-daemon.md v9: outcome 5, UC-7, I-5).
// His units are the day files of his messages (core/search-human-words.mjs). The notes, conversation rows and ledger
// rows that quote him stay in the list below them as context. The reorder drops nothing, and a question that does not
// ask for his words is never touched.

import { resolve, sep } from "node:path";
import { cleanHumanName, escapeRegex } from "./search.mjs";

// \b fails on å, ä and ö, so a word is bounded by what is not a letter, a digit or an underscore, as the phrase search is.
const WORD_START = "(?<![\\p{L}\\p{N}_])";
const WORD_END = "(?![\\p{L}\\p{N}_])";
const alt = (...options) => `(?:${options.join("|")})`;

const SWEDISH_VERBS = alt("sade", "sa", "skrev", "bad", "tyckte", "ville", "menade", "beslutade", "bestämde");

/**
 * Each form is a run of whole words with white space between them. `self` is his name as a pattern, and `who` is him in
 * any of the ways a question names him. Every form needs his name or "han", "hans", "he" or "his" beside the verb or the
 * noun, so a question about another pane's words does not match.
 */
function formsOf(self) {
  const who = alt(self, "han", "he");
  return [
    `${alt("vad", "hur")}\\s+${SWEDISH_VERBS}\\s+${who}`,
    `${self}\\s+${alt("ordagrant", "exakt", "citat")}`,
    `hans\\s+(?:${alt("egna", "exakta")}\\s+)?${alt("ord", "beslut")}`,
    "sa\\s+han",
    `${self}s?\\s+beslut`,
    `what\\s+did\\s+${who}\\s+${alt("say", "ask", "write", "decide", "want")}`,
    `${alt(`${self}['’]s`, "his")}\\s+(?:${alt("own", "exact")}\\s+)?${alt("words", "decision")}`,
    `${self}\\s+verbatim`,
  ];
}

/**
 * WHAT: Checks whether a question asks for what he said, wrote or decided.
 * WHY: Keeps other questions' order untouched; with no configured name there is no intent.
 */
export function asksForHisWords(query, name) {
  const him = cleanHumanName(name);
  if (!him || typeof query !== "string") return false;
  const self = him.split(" ").map(escapeRegex).join("\\s+");
  return new RegExp(`${WORD_START}${alt(...formsOf(self))}${WORD_END}`, "iu").test(query);
}

/**
 * WHAT: Returns the hits with those under his folder first, each group in its own order.
 * WHY: Keeps agent rows that quote him below his words without dropping a hit.
 */
export function hisWordsFirst(hits, humanDir) {
  // No folder, as when the search leaves his root out: no hit is his and the order stays.
  if (!humanDir) return [...hits];
  const folder = resolve(humanDir) + sep;
  const isHis = (hit) => typeof hit.path === "string" && resolve(hit.path).startsWith(folder);
  return [...hits.filter(isHis), ...hits.filter((hit) => !isHis(hit))];
}
