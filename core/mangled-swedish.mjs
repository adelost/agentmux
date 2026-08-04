/**
 * WHAT: Flags author-side Swedish text that already lost every ÅÄÖ before transport.
 * WHY: Keeps text that was mangled at composition time from passing as clean bytes.
 */

// AI-0014 made declared quotes byte-exact through --expect-file. That verifies
// what an author REMEMBERS to declare; text mangled while it was being written
// still passes, because the mangled bytes are what the file holds. This check
// looks at the text itself instead of at a declaration.
//
// The signal is deliberately narrow: a paragraph is suspect only when it reads
// as Swedish AND contains not one å, ä or ö. A single diacritic anywhere clears
// the whole paragraph, because real mangling is total, never partial. Swedish
// spells å/ä/ö often enough that a genuine paragraph almost always carries one.
//
// The length floor is the load-bearing part, and it was measured, not guessed.
// The dominant false alarm is NOT English or technical prose - neither corpus
// produced a single one. It is SHORT, entirely correct Swedish that happens to
// need no diacritic: "PR #49 mergad som e94f730d och finns i live-builden",
// "Varje har ett jobb." For a short paragraph the rule is unsound in principle,
// not merely miscalibrated: there is not enough text for absence of a diacritic
// to mean anything. Long paragraphs do not have that problem.
//
// Measured on 6937 paragraphs of real agent-authored history, sweeping the floor
// (see docs/mangled-swedish-measurement.json): at >=8 words, 247 flagged with 17
// hand-audited false alarms; at >=40 words, 184 flagged with ZERO. ai:2 measured
// a different corpus (534 board documents) and landed on the same floor with
// 14/14 hand-reviewed flags genuine. Two corpora, one operating point.
//
// The check WARNS and counts; it does not reject. Making it blocking is a
// separate, deliberate decision that should cite a fresh number.

const DIACRITIC = /[åäöÅÄÖ]/u;
const WORD = /[\p{L}]+/gu;

/** WHAT: Names the smallest paragraph worth judging. WHY: Below it, missing diacritics carry no signal at all. */
export const MIN_PARAGRAPH_WORDS = 40;

/** WHAT: Names how many distinct markers make a paragraph read as Swedish. WHY: One shared word is coincidence, three is a language. */
export const MIN_SWEDISH_MARKERS = 3;

// Swedish function words that survive mangling because they never had a
// diacritic to lose. Words that also occur in English or in technical prose
// ("till", "men", "under", "over", "en", "av", "i", "med", plus the mangled
// look-alikes "for", "pa", "ar", "sa") are DELIBERATELY absent: they were
// measured to roughly double the false-alarm count while adding no real catches,
// because a mangled Swedish paragraph always carries plenty of the rest.
const SWEDISH_MARKERS = new Set([
  "och", "att", "inte", "som", "det", "den", "detta", "denna", "dessa",
  "har", "hade", "kan", "kunde", "ska", "skulle", "eller", "ett",
  "jag", "vi", "dig", "mig", "sig", "hans", "hennes", "deras",
  "eftersom", "redan", "sedan", "bara", "mycket", "hela", "varje", "andra",
  "utan", "genom", "mellan", "innan", "aldrig", "alltid", "kanske",
  "vilket", "vilken", "vilka", "ingen", "inga", "inget",
  "gjorde", "gjort", "blir", "blev", "finns", "fanns", "heter",
  "ligger", "kommer", "tar", "ger", "vet", "ser",
]);

function paragraphsOf(text) {
  return String(text ?? "").split(/\n\s*\n/u);
}

function swedishMarkersIn(paragraph) {
  const found = new Set();
  for (const word of paragraph.toLowerCase().match(WORD) ?? []) {
    if (SWEDISH_MARKERS.has(word)) found.add(word);
  }
  return found;
}

/**
 * WHAT: Reports paragraphs that read as Swedish while carrying no ÅÄÖ at all.
 * WHY: Keeps the judgement on the text itself, not on what an author declared.
 */
export function findManglingRisk(text) {
  const findings = [];
  paragraphsOf(text).forEach((raw, index) => {
    const paragraph = raw.trim();
    const words = paragraph.match(WORD) ?? [];
    if (words.length < MIN_PARAGRAPH_WORDS) return;
    if (DIACRITIC.test(paragraph)) return;
    const markers = swedishMarkersIn(paragraph);
    if (markers.size < MIN_SWEDISH_MARKERS) return;
    findings.push({
      paragraphIndex: index,
      markers: [...markers].sort(),
      excerpt: paragraph.replace(/\s+/gu, " ").slice(0, 120),
    });
  });
  return findings;
}

function allStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => allStrings(item, output));
  }
  return output;
}

/**
 * WHAT: Scans every string in one request payload for mangled Swedish.
 * WHY: Keeps the check on the exact bytes about to be sent, not on one field.
 */
export function findManglingRiskInPayload(value) {
  return allStrings(value).flatMap((text) => findManglingRisk(text));
}

/**
 * WHAT: Renders one counted warning for a set of findings.
 * WHY: Keeps the operator's evidence a number and a sample, not a vague caution.
 */
export function describeManglingRisk(findings) {
  if (findings.length === 0) return null;
  const one = findings.length === 1;
  const subject = one ? "paragraph reads" : "paragraphs read";
  const verb = one ? "contains" : "contain";
  const lines = [
    `WARNING: ${findings.length} ${subject} as Swedish but ${verb} no a-ring or umlaut at all.`,
    "  Text mangled while it was written passes --expect-file, because the mangled",
    "  bytes are what the file holds. Check the source before sending.",
  ];
  findings.slice(0, 3).forEach((finding) => {
    lines.push(`  - [${finding.markers.slice(0, 4).join(" ")}] ${finding.excerpt}`);
  });
  if (findings.length > 3) lines.push(`  ... and ${findings.length - 3} more`);
  return lines.join("\n");
}
