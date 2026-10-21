#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const normalize = (text) => text.replace(/\s+/gu, " ").trim();

// WHAT: Reads only policy files directly linked from the register. WHY: An unlinked archive cannot preserve an actionable rule.
export function linkedFleetPolicy(register, read = (path) => readFileSync(path, "utf8")) {
  const files = [...new Set([...register.matchAll(/\[[^\]]+\]\(([^)]+\/docs\/fleet\/[^)#]+\.md)\)/gu)].map((m) => m[1]))];
  return { files, text: [register, ...files.map(read)].join("\n\n") };
}

// WHAT: Checks every old policy paragraph, including dated rules and quotes. WHY: Prevents relocation or new wrapping from losing words and punctuation.
export function checkFleetPolicy(before, register, read) {
  const policy = linkedFleetPolicy(register, read);
  const corpus = normalize(policy.text);
  const paragraphs = before.split(/\n\s*\n|\n(?=\d+\. \*\*|## )/gu)
    .map((paragraph) => paragraph.replace(/^<!-- amux-hints-(?:version:.*|end) -->\n?/gmu, ""))
    .map(normalize).filter(Boolean);
  const missing = paragraphs.filter((paragraph) => !corpus.includes(paragraph));
  return { ok: missing.length === 0, paragraphs: paragraphs.length, files: policy.files, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [beforeFile, registerFile] = process.argv.slice(2);
  if (!beforeFile || !registerFile) {
    console.error("Usage: node bin/check-fleet-policy.mjs BEFORE.md REGISTER.md");
    process.exitCode = 2;
  } else {
    try {
      const result = checkFleetPolicy(readFileSync(beforeFile, "utf8"), readFileSync(registerFile, "utf8"));
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = result.ok ? 0 : 1;
    } catch (error) {
      console.error(`fleet-policy: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
