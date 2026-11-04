import { execFileSync } from "node:child_process";

const DAY = 86400000;
// A row is named in a subject as its own token: "1343:", "(row 1343,", "1246b". Letters or digits around it make another word.
const ROW_TOKEN = /(?<![\p{L}\d])\d+[a-z]*(?![\p{L}\d])/gu;

/** WHAT: Indexes non-merge commits that change code by the row ids their subjects name. WHY: Keeps the watch on code, so ledger edits never stand in for work. */
export function stateAgeCodeIndex(project, tip, until, days = 8) {
  const out = execFileSync("git", ["-C", project.root, "log", "--no-merges", `--since=${new Date(until - days * DAY).toISOString()}`,
    `--until=${new Date(until).toISOString()}`, "--format=%x00%ct %s", "--name-only", tip],
  { encoding: "utf8", timeout: 30000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  const byRow = new Map();
  for (const record of out.split("\0").slice(1)) {
    const [head, ...paths] = record.split("\n");
    const at = Number(head.slice(0, head.indexOf(" "))) * 1000, subject = head.slice(head.indexOf(" ") + 1);
    if (!paths.some(path => path && path !== project.ledger && !path.startsWith("docs/") && !path.endsWith(".md"))) continue;
    for (const id of new Set(subject.match(ROW_TOKEN) || [])) byRow.set(id, [...byRow.get(id) || [], at]);
  }
  return byRow;
}

/** WHAT: Resolves each row's latest code commit at or before the observation time. WHY: Keeps a replay tick from seeing commits made after it. */
export const stateAgeWithCode = (rows, index, now) => rows.map(row => {
  const times = (index.get(row.row) || []).filter(at => at <= now);
  return { ...row, codeAt: times.length ? Math.max(...times) : null };
});
