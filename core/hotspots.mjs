/**
 * WHAT: Hotspot reflection rules. A function that keeps changing on trunk gets a recorded verdict
 * (REWRITE, SPLIT or KEEP) before the next change to it is committed.
 * WHY: Measured 2026-09-16 on Skyvw, swoop-sim and ai-dsl: complexity scores did not predict fixes beyond
 * function size, but churn did (odds x2 per doubling after size), and reading a hot function's fix
 * history told a worthwhile rewrite from noise. See workspace memory/references/code-hotspots-experiment-2026-09-16.md.
 */

export const HOTSPOT_VERDICTS = ["REWRITE", "SPLIT", "KEEP"];

export const DEFAULT_HOTSPOT_POLICY = Object.freeze({
  /** Trunk commits among a function's current lines within the window that make it hot. */
  minChurn: 6,
  windowDays: 60,
  /** A verdict stays current until this many more trunk commits touch the function. */
  reopenAfter: 3,
});

const FIX_SUBJECT = /^(fix|hotfix|bugfix)[(:!\s]/iu;

/** Source files lizard can split into functions. Other files never hold a hotspot. */
const FUNCTION_SOURCE = /\.(kt|java|js|mjs|cjs|jsx|ts|tsx|py|go|rs|swift|c|cc|cpp|h|hpp|cs|rb|php|scala|lua)$/iu;

export const isFunctionSource = (path) => FUNCTION_SOURCE.test(path);
export const isFixSubject = (subject) => FIX_SUBJECT.test(String(subject || ""));
export const functionKey = (fn) => `${fn.path}::${fn.name}`;

/** Parses `lizard --csv` rows into functions with their line span. */
export function parseLizardCsv(text) {
  return String(text || "").split(/\r?\n/u).filter(Boolean).map((line) => {
    const fields = csvFields(line);
    return {
      nloc: Number(fields[0]),
      ccn: Number(fields[1]),
      path: fields[6],
      name: fields[7],
      start: Number(fields[9]),
      end: Number(fields[10]),
    };
  }).filter((fn) => fn.path && fn.name && Number.isInteger(fn.start) && Number.isInteger(fn.end));
}

function csvFields(line) {
  const fields = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') { current += '"'; index++; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { fields.push(current); current = ""; }
    else current += char;
  }
  fields.push(current);
  return fields;
}

/**
 * Old-side line ranges of `git diff -U0` hunks, per file. A pure insertion (`-a,0`) touches the lines
 * around its insertion point, so adding a branch inside a function counts as changing it.
 */
export function parseChangedRanges(diffText) {
  const ranges = new Map();
  let path = null;
  for (const line of String(diffText || "").split(/\r?\n/u)) {
    const file = /^--- a\/(.+)$/u.exec(line);
    if (file) { path = file[1]; continue; }
    if (/^--- \/dev\/null/u.test(line)) { path = null; continue; }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(line);
    if (!hunk || !path) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const range = count === 0 ? [Math.max(start, 1), start + 1] : [start, start + count - 1];
    ranges.set(path, [...(ranges.get(path) || []), range]);
  }
  return ranges;
}

const isAnonymous = (fn) => fn.name === "(anonymous)";
const span = (fn) => fn.end - fn.start;

/**
 * The function that owns a line: the innermost named function around it, else the innermost anonymous one.
 * Callbacks and lambdas belong to the function that declares them, and a factory does not own its inner
 * functions' lines, so a module-sized closure is not hot just because its members are.
 */
export function lineOwner(fileFunctions, line) {
  const around = fileFunctions.filter((fn) => fn.start <= line && line <= fn.end);
  const named = around.filter((fn) => !isAnonymous(fn));
  const pool = named.length ? named : around;
  return pool.reduce((best, fn) => (!best || span(fn) < span(best) ? fn : best), null);
}

/** Functions that own a changed line. */
export function touchedFunctions(functions, changedRanges) {
  const touched = new Set();
  for (const [path, ranges] of changedRanges) {
    const fileFunctions = functions.filter((fn) => fn.path === path);
    for (const [start, end] of ranges) {
      for (let line = start; line <= end; line++) {
        const owner = lineOwner(fileFunctions, line);
        if (owner) touched.add(owner);
      }
    }
  }
  return functions.filter((fn) => touched.has(fn));
}

/**
 * Trunk churn of one function: distinct trunk commits among the current lines it owns.
 * `fileFunctions` are all functions in its file (for ownership), `blame` is [{ start, count, sha }] for that file
 * and `commits` maps sha -> { subject }.
 */
export function functionChurn(fn, fileFunctions, blame, trunkShas, commits) {
  const shas = new Set();
  for (const { start, count, sha } of blame) {
    if (!trunkShas.has(sha) || shas.has(sha)) continue;
    for (let line = Math.max(start, fn.start); line <= Math.min(start + count - 1, fn.end); line++) {
      if (lineOwner(fileFunctions, line) === fn) { shas.add(sha); break; }
    }
  }
  const history = [...shas].map((sha) => ({ sha, subject: commits.get(sha)?.subject || "", fix: isFixSubject(commits.get(sha)?.subject) }));
  return { churn: shas.size, fixes: history.filter((commit) => commit.fix).length, history };
}

/** The newest recorded verdict for a function key, or null. */
export function latestVerdict(ledger, key) {
  return ledger.filter((entry) => entry.key === key).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1) || null;
}

/** Why a hot function needs reflection now, or null when it does not. */
export function reflectionDue(hotspot, ledger, policy = DEFAULT_HOTSPOT_POLICY) {
  if (hotspot.churn < policy.minChurn) return null;
  const verdict = latestVerdict(ledger, functionKey(hotspot));
  if (!verdict) return { reason: "no verdict yet", verdict: null };
  if (hotspot.churn - Number(verdict.churn || 0) >= policy.reopenAfter) {
    return { reason: `${hotspot.churn - verdict.churn} trunk commits since the ${verdict.verdict} verdict`, verdict };
  }
  return null;
}

/** Validates and builds one ledger entry. Throws on an unusable verdict: the ledger is the experiment's data. */
export function verdictEntry({ hotspot, verdict, reason, repo, headSha, by, at = new Date().toISOString() }) {
  const normalized = String(verdict || "").toUpperCase();
  if (!HOTSPOT_VERDICTS.includes(normalized)) throw new Error(`verdict must be one of ${HOTSPOT_VERDICTS.join(", ")}`);
  if (String(reason || "").trim().length < 12) throw new Error("reason must say in one sentence why (at least 12 characters)");
  return {
    schemaVersion: 1, at, repo, key: functionKey(hotspot), path: hotspot.path, name: hotspot.name,
    churn: hotspot.churn, fixes: hotspot.fixes, nloc: hotspot.nloc, headSha, verdict: normalized,
    reason: String(reason).trim(), by: by || null,
  };
}

/**
 * Directories where a shell command runs `git commit`, resolved from `cd DIR &&` prefixes and `git -C DIR`.
 * Plumbing such as `git commit-tree` is not a commit a person reflects on.
 */
export function commitDirectories(command, cwd, home) {
  const expand = (path) => {
    const unquoted = path.replace(/^(['"])(.*)\1$/u, "$2");
    const tilde = unquoted.replace(/^~(?=\/|$)/u, home);
    return tilde.startsWith("/") ? tilde : `${cwd.replace(/\/$/u, "")}/${tilde}`;
  };
  const directories = [];
  let dir = cwd;
  for (const segment of String(command || "").split(/&&|\|\||;|\n/u)) {
    const cd = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*$/u.exec(segment);
    if (cd) { dir = expand(cd[1]); continue; }
    const commit = /(?:^|[\s(])git((?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)|\s+-c\s+\S+)*)\s+commit(?![-\w])/u.exec(segment);
    if (!commit) continue;
    const target = /-C\s+("[^"]+"|'[^']+'|\S+)/u.exec(commit[1]);
    directories.push(target ? expand(target[1]) : dir);
  }
  return [...new Set(directories)];
}

/**
 * Function keys a shell command records verdicts for before it commits, e.g.
 * `amux churn verdict 'a.js::step' KEEP "..." && git commit`. The hook sees the command before it runs,
 * so without this a verdict chained ahead of its commit would be held as missing.
 */
export function verdictKeysInCommand(command) {
  const keys = new Set();
  for (const match of String(command || "").matchAll(/\bchurn\s+verdict\s+("[^"]+"|'[^']+'|\S+)/gu)) {
    keys.add(match[1].replace(/^(['"])(.*)\1$/u, "$2"));
  }
  return keys;
}

/** The brief an agent reads when a commit is held for reflection. */
export function formatReflectionBrief(due, policy = DEFAULT_HOTSPOT_POLICY) {
  const lines = [
    `Hotspot reflection needed (amux churn). These changed functions have ${policy.minChurn}+ trunk commits in ${policy.windowDays} days:`,
  ];
  for (const { hotspot, reason } of due) {
    lines.push(`  ${hotspot.path}:${hotspot.start} ${hotspot.name} · ${hotspot.churn} commits, ${hotspot.fixes} fixes · ${reason}`);
    for (const commit of hotspot.history.filter((item) => item.fix).slice(0, 8)) {
      lines.push(`    ${commit.sha.slice(0, 9)} ${commit.subject}`);
    }
  }
  lines.push(
    "Read each function and its fix diffs (git show <sha> -- <path>). Did the fixes come from the function's own",
    "branching or state (SPLIT or REWRITE), or from elsewhere: constants, copy, upstream values, features (KEEP)?",
    "Record one verdict per function, then run the commit again:",
    ...due.map(({ hotspot }) => `  amux churn verdict '${functionKey(hotspot)}' KEEP|SPLIT|REWRITE "<why, one sentence>"`),
    `A SPLIT or REWRITE small enough for this change belongs in it; otherwise it stays listed by \`amux churn functions\`.`,
    `A verdict stays current until ${policy.reopenAfter} more trunk commits touch the function.`,
  );
  return lines.join("\n");
}
