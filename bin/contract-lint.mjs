#!/usr/bin/env node
/**
 * WHAT: Walks a repo path and reports WHAT:/WHY: contract findings per source file.
 * WHY: Keeps the proving runner standalone so it never touches the contended CLI.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";
import { lintSource, SOURCE_EXTS, SKIP_DIRS } from "../core/contract-lint.mjs";

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (SOURCE_EXTS.includes(extname(p)) && !/\.(test|spec)\.|(_test|Test|Tests)\.|^test_/.test(name)) out.push(p);
  }
  return out;
}

const args = process.argv.slice(2);
const showLines = args.includes("--show");
const root = args.find((a) => !a.startsWith("--")) || ".";
const files = walk(root, []);

let errors = 0;
let warns = 0;
const byCode = {};
const samples = [];
for (const file of files) {
  let findings;
  try {
    findings = lintSource(file, readFileSync(file, "utf-8"), extname(file));
  } catch {
    continue;
  }
  for (const f of findings) {
    byCode[f.code] = (byCode[f.code] || 0) + 1;
    if (f.sev === "error") errors += 1;
    else warns += 1;
    if (f.code === "CONTRACT020" || f.code === "CONTRACT030") {
      if (samples.length < 25) samples.push(`${file.replace(root, "").replace(/^\//, "")}:${f.line}  ${f.msg}`);
    }
  }
}

console.log(`\ncontract-lint  ${root}`);
console.log(`files: ${files.length}   errors: ${errors}   warnings: ${warns}`);
console.log("by code:");
for (const code of Object.keys(byCode).sort()) console.log(`  ${code}: ${byCode[code]}`);
if (showLines && samples.length) {
  console.log("\nvoice samples (banned phrase / missing boundary):");
  for (const s of samples) console.log(`  ${s}`);
}
