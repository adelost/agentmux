#!/usr/bin/env node
/**
 * WHAT: Re-derives the mangled-Swedish flag counts from real authored history.
 * WHY: Keeps the attestation's number reproducible instead of quoted from memory.
 */

// Usage: node bin/measure-mangled-swedish.mjs [--json]
//
// Reads two corpora of genuine agent-authored text:
//   ~/.agentmux/suggestions-authoring-outbox/*.body.json  (what was actually sent)
//   ~/.openclaw/workspace/memory/*.md                     (mixed sv/en/technical)
//
// It reports how many paragraphs the check FLAGS. It cannot report how many of
// those are true mangling, because that judgement needs a reader: the audited
// split lives in docs/mangled-swedish-measurement.json next to the date and
// method that produced it. Re-run this after changing the word list or the
// thresholds; if the flag count moves, the audited split is stale.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  MIN_PARAGRAPH_WORDS, MIN_SWEDISH_MARKERS, findManglingRisk,
} from "../core/mangled-swedish.mjs";

const OUTBOX = join(homedir(), ".agentmux", "suggestions-authoring-outbox");
const MEMORY = join(homedir(), ".openclaw", "workspace", "memory");
const WORD = /[\p{L}]+/gu;

function allStrings(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => allStrings(item, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => allStrings(item, output));
  }
  return output;
}

function readDirSafe(path) {
  try { return readdirSync(path); } catch { return []; }
}

function texts(corpus) {
  if (corpus === "outbox") {
    return readDirSafe(OUTBOX).filter((name) => name.endsWith(".body.json"))
      .flatMap((name) => {
        try { return allStrings(JSON.parse(readFileSync(join(OUTBOX, name), "utf8"))); }
        catch { return []; }
      });
  }
  return readDirSafe(MEMORY).filter((name) => name.endsWith(".md"))
    .filter((name) => statSync(join(MEMORY, name)).isFile())
    .map((name) => readFileSync(join(MEMORY, name), "utf8"));
}

function measure(corpus) {
  let considered = 0;
  let flagged = 0;
  for (const text of texts(corpus)) {
    for (const raw of String(text).split(/\n\s*\n/u)) {
      if ((raw.match(WORD) ?? []).length >= MIN_PARAGRAPH_WORDS) considered += 1;
    }
    flagged += findManglingRisk(text).length;
  }
  return { corpus, considered, flagged };
}

const rows = ["outbox", "memory"].map(measure);
const total = rows.reduce((sum, row) => ({
  considered: sum.considered + row.considered, flagged: sum.flagged + row.flagged,
}), { considered: 0, flagged: 0 });

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    minParagraphWords: MIN_PARAGRAPH_WORDS,
    minSwedishMarkers: MIN_SWEDISH_MARKERS,
    corpora: rows,
    total,
  }, null, 2));
} else {
  console.log(`thresholds: >=${MIN_PARAGRAPH_WORDS} words, >=${MIN_SWEDISH_MARKERS} Swedish markers, zero diacritics`);
  for (const row of rows) {
    const pct = row.considered ? (100 * row.flagged / row.considered).toFixed(2) : "0.00";
    console.log(`  ${row.corpus.padEnd(7)} ${String(row.flagged).padStart(4)} flagged / ${row.considered} paragraphs (${pct}%)`);
  }
  const pct = total.considered ? (100 * total.flagged / total.considered).toFixed(2) : "0.00";
  console.log(`  ${"TOTAL".padEnd(7)} ${String(total.flagged).padStart(4)} flagged / ${total.considered} paragraphs (${pct}%)`);
  console.log("\nAudited split (who is right and who is a false alarm): docs/mangled-swedish-measurement.json");
}
