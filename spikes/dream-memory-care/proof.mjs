// WHAT: Exercises ordinary memory edits in a limited local Git worktree.
// WHY: Qualifies the smallest care path without changing Dream startup or buying a model turn.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { assertDreamWritePath, prepareDreamMemoryEffects, readDreamRegular, verifyDreamMemoryEffects } from "../../core/dream-memory-effects.mjs";
import { readDreamOwnerResult } from "../../core/dream-owner.mjs";
import { lintMemory } from "../../core/memory-lint.mjs";
import { scanAddedSecrets } from "../../core/memory-bank.mjs";

const INDEX = "MEMORY.md", REFERENCE = "memory/references/memory-flow.md";
const HISTORY = "memory/references/memory-flow-history.md";
const SCOPE = [INDEX, REFERENCE, HISTORY];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const [sourceArg, outputArg] = process.argv.slice(2);
assert(sourceArg && outputArg && process.argv.length === 4, "Usage: node proof.mjs SOURCE_WORKSPACE NEW_PRIVATE_OUTPUT");
const source = resolve(sourceArg), output = resolve(outputArg);
assert(!output.startsWith(`${source}${sep}`) && source !== output, "Output must be outside the source workspace");
assertDreamWritePath(join(output, "receipt.json"));
assert(!existsSync(output), "Proof output already exists; read its receipt instead of replaying it");
mkdirSync(output, { recursive: true, mode: 0o700 });

function put(root, path, content) {
  const target = join(root, path);
  assertDreamWritePath(target);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, content, { mode: 0o600 });
}

function git(cwd, args, input, allowFailure = false) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
  if (!allowFailure) assert.equal(result.status, 0, `git ${args[0]}: ${result.stderr}`);
  return result;
}

// Only these source bytes are read; no daily history, raw journal or credential is copied.
const originals = Object.fromEntries([INDEX, REFERENCE].map(path => {
  assertDreamWritePath(join(source, path));
  return [path, readDreamRegular(join(source, path), 128 * 1024).toString("utf8")];
}));
const base = join(output, "intake"), care = join(output, "care");
mkdirSync(base, { mode: 0o700 });
git(base, ["init", "-q", "--initial-branch=intake"]);
git(base, ["config", "user.name", "Dream local proof"]);
git(base, ["config", "user.email", "dream-proof@localhost"]);
for (const [path, content] of Object.entries(originals)) put(base, path, content);
git(base, ["add", "--", INDEX, REFERENCE]);
git(base, ["commit", "-qm", "Local bounded memory source; no remote"]);
const baseline = git(base, ["rev-parse", "HEAD"]).stdout.trim();
git(base, ["worktree", "add", "-q", "-b", "care", care, baseline]);
const lint = root => lintMemory(root, { home: join(output, "empty-home"), now: new Date("2026-10-24T15:46:00Z") });
const warnings = result => result.findings.filter(row => row.severity === "warning")
  // A moved unchanged paragraph can carry the same missing out-of-scope target.
  .map(row => JSON.stringify([row.code, row.file === HISTORY ? REFERENCE : row.file, row.message])).sort();
const beforeLint = lint(care);

// These are ordinary authored Markdown edits, not a JSON edit/repair language.
const original = originals[REFERENCE];
const start = original.indexOf("## Daterat läge, inte eviga sanningar\n");
const end = original.indexOf("## Primärkällor för upplägget\n");
assert(start > 0 && end > start, "The source structure changed; stop rather than guessing a new split");
const moved = original.slice(start, end);
const headings = [...moved.matchAll(/^## (.+)$/gm)].map(match => match[1]);
const anchor = heading => heading.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/gu, "-");
const bridges = headings.map(heading => `## ${heading}\n\nHistoriskt källbundet kvitto: [oförändrat avsnitt](memory-flow-history.md#${anchor(heading)}).\n\n`).join("");
put(care, REFERENCE, original.slice(0, start) + bridges + original.slice(end));
put(care, HISTORY, [
  "> summary: Daterade leverans- och undersökningskvitton för minnesflödet, september2026.",
  "> why: Håller historisk bevisning skild från den korta aktuella routingreferensen utan att skriva om fakta.",
  "", "# Minnesflödets historiska kvitton", "",
  `Flyttat oförändrat från [minnesflödet](memory-flow.md); källans SHA256: ${hash(original)}.`, "", moved,
  "## Läsning av historiken", "", "Kvittona ovan är daterad historik. [Aktuell routing](memory-flow.md) läses tillsammans med nuvarande instruktioner.\n",
].join("\n"));
const index = originals[INDEX].replace("(`references/memory-flow.md`)", "(`memory/references/memory-flow.md`)");
assert(index !== originals[INDEX], "Expected index reference was not found; do not invent an edit");
put(care, INDEX, index.replace("|-----|----------|", "|-----|----------|\n| `memory/references/memory-flow.md` | Minnets ansvar och aktuell routing; daterade kvitton finns i `memory/references/memory-flow-history.md` |"));
assert(readFileSync(join(care, HISTORY), "utf8").includes(moved), "Historical facts must remain byte-for-byte");
assert(headings.every(heading => readFileSync(join(care, REFERENCE), "utf8").includes(`## ${heading}\n`)), "Old heading links must retain their anchors");
git(care, ["add", "--", ...SCOPE]);
const names = git(care, ["diff", "--cached", "--no-renames", "--name-only", "-z", baseline]).stdout.split("\0").filter(Boolean);
assert.deepEqual([...names].sort(), [...SCOPE].sort());
const patch = git(care, ["diff", "--cached", "--binary", "--no-ext-diff", "--no-renames", baseline]).stdout;
assert.equal(scanAddedSecrets(patch).length, 0, "Care diff contains a secret-shaped addition");
const afterLint = lint(care);
assert.deepEqual(warnings(afterLint), warnings(beforeLint), "Care must not add lint warnings");
put(output, "care.diff", patch);

// Reproduce the installed snapshot's concurrent-write failure in the LOCAL intake only.
const inputPath = join(output, "controller/input.json");
const descriptor = prepareDreamMemoryEffects({ workspace: base, inputPath });
const input = JSON.stringify({ memoryGuard: { effects: descriptor } });
put(output, "controller/input.json", input);
put(output, "controller/input.summary.md", "Local synthetic result, no model call.\n");
const unchangedEffects = verifyDreamMemoryEffects({ inputPath, inputSha256: hash(input), descriptor, workspace: base });
assert(unchangedEffects.files > 0, "The unchanged snapshot must pass before testing concurrent writes");
const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
  import { mkdirSync, writeFileSync } from 'node:fs';
  import { join } from 'node:path';
  const base = process.argv[1];
  mkdirSync(join(base, 'memory/references'), { recursive: true });
  writeFileSync(join(base, 'memory/references/other-agent.md'), '> summary: Another owner\\n> why: Concurrent edit\\n\\nOther owner fact.\\n');
  writeFileSync(join(base, 'memory/2026-10-24.md'), '> summary: Local fixture\\n> why: Concurrent own heading\\n\\n## Other owner\\nA separate process wrote this note.\\n');
`, base], { encoding: "utf8" });
assert.equal(child.status, 0, child.stderr);
let oldGuardError;
try { verifyDreamMemoryEffects({ inputPath, inputSha256: hash(input), descriptor, workspace: base }); }
catch (error) { oldGuardError = error.message; }
assert.match(oldGuardError || "", /dream-curator-touched-memory/);
put(output, "red.json", JSON.stringify({ oldGlobalGuard: "rejected an unrelated process", reason: oldGuardError }, null, 2));

// Git applies only the intended diff, preserving unrelated base writes.
const other = readFileSync(join(base, "memory/references/other-agent.md"));
const daily = readFileSync(join(base, "memory/2026-10-24.md"));
git(base, ["apply", "--check", "--whitespace=error", "-"], patch);
git(base, ["apply", "--whitespace=error", "-"], patch);
assert.deepEqual(readFileSync(join(base, "memory/references/other-agent.md")), other);
assert.deepEqual(readFileSync(join(base, "memory/2026-10-24.md")), daily);
for (const path of SCOPE) assert.deepEqual(readFileSync(join(base, path)), readFileSync(join(care, path)));

// A competing touched-file edit refuses the complete patch, leaving the draft intact.
const conflict = join(output, "conflict");
git(base, ["worktree", "add", "-q", "--detach", conflict, baseline]);
put(conflict, REFERENCE, originals[REFERENCE].replace("## Daterat läge, inte eviga sanningar", "## Other owner's replacement heading"));
const conflictBefore = readFileSync(join(conflict, REFERENCE));
const refusal = git(conflict, ["apply", "--check", "-"], patch, true);
assert.notEqual(refusal.status, 0, "A competing changed hunk must refuse publication");
assert.deepEqual(readFileSync(join(conflict, REFERENCE)), conflictBefore);
assert.equal(readFileSync(join(output, "care.diff"), "utf8"), patch);
assert(!existsSync(join(conflict, HISTORY)), "Refusal must not partly publish the new history file");

// Invalid care cannot invalidate a separately valid digest product.
const digestPath = "controller/summary.md", owner = { agent: "fixture", pane: 0 };
put(output, digestPath, "> Kuraterad av fixture:0 efter verifierad kompaktering · run `local-proof` · source `fixture-hash`.\n- Lokalt syntetiskt produktprov; ingen historisk natt eller modellkörning.\n");
const readDigest = () => readDreamOwnerResult(join(output, digestPath), "2026-10-24", "local-proof", owner, "fixture-hash");
assert.equal(readDigest().ok, true);
const digestHash = hash(readFileSync(join(output, digestPath)));
put(care, INDEX, readFileSync(join(care, INDEX), "utf8") + "\n`memory/references/missing-proof-reference.md`\n");
assert(lint(care).findings.some(row => row.code === "broken_link" && row.message.includes("missing-proof-reference")));
assert.equal(readDigest().ok, true);
assert.equal(hash(readFileSync(join(output, digestPath))), digestHash);
put(care, INDEX, readFileSync(join(base, INDEX)));
git(care, ["commit", "-qm", "Care draft: preserve historical facts and index routing"]);

for (const [path, content] of Object.entries(originals)) assert.equal(readDreamRegular(join(source, path), 128 * 1024).toString("utf8"), content, `Real source changed: ${path}`);
const receipt = {
  row: "76c", kind: "local-mechanical-proof-only", completedAt: new Date().toISOString(), source,
  sourceSha256: Object.fromEntries(Object.entries(originals).map(([path, bytes]) => [path, hash(bytes)])),
  baseline, careCommit: git(care, ["rev-parse", "HEAD"]).stdout.trim(), scope: SCOPE,
  patchSha256: hash(patch), lint: { before: beforeLint.summary, after: afterLint.summary, newWarnings: 0 },
  concurrentSeparateProcess: { unchangedOldGuard: "green", oldGuard: "red", intendedDiff: "green", referencePreserved: true, dailyPreserved: true },
  competingHunk: { refused: true, partialWrites: false, draftPreserved: true },
  careLintFailure: { detected: true, validSyntheticDigestPreserved: true },
  factMovement: { exactMovedBytes: Buffer.byteLength(moved), preservedHeadingAnchors: headings.length },
  sourceUnchanged: true, installed: false, modelCalls: 0, historicalImports: 0,
  limits: ["No configured curator was started", "Worktree is not an OS permission boundary", "No scheduled care/digest integration", "No concurrent publication lock or atomic multi-file publisher qualified", "Lint does not prove semantic truth", "Scoped copy omits other source targets/templates: existing warnings retained, including explicit moved-file attribution"],
};
put(output, "receipt.json", JSON.stringify(receipt, null, 2) + "\n");
put(output, "lint.json", JSON.stringify({ before: beforeLint, after: afterLint }, null, 2) + "\n");
console.log(JSON.stringify(receipt, null, 2));
