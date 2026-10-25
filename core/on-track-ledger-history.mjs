import { onTrackGit, onTrackRows } from "./on-track-evidence.mjs";

/** WHAT: Reads immutable outcome history independently of C1 source collection. WHY: Keeps a history budget or ambiguous table from discarding the human-order baseline. */
export function readOnTrackLedgerHistory(project, tip, at) {
  const since = new Date(at - 86400000).toISOString();
  const base = onTrackGit(project.root, ["rev-list", "-1", `--before=${since}`, tip, "--", project.ledger]).trim();
  const commits = onTrackGit(project.root, ["log", "--reverse", "--format=%H %ct", `--since=${since}`, tip, "--", project.ledger]).trim().split("\n").filter(Boolean);
  const errors = [];
  const historicalRows = sha => {
    try { return onTrackRows(onTrackGit(project.root, ["show", `${sha}:${project.ledger}`])); }
    catch (error) { errors.push({ sha, error: error.message }); return null; }
  };
  let previous = base ? historicalRows(base) : {};
  const rowFirstSeen = {}, changes = [], started = performance.now();
  for (const [position, commit] of commits.entries()) {
    const [sha, seconds] = commit.split(" ");
    if (performance.now() - started > 45000) {
      errors.push({ sha, error: "History source read exceeded45s controller budget; C1 input remains complete", remainingCommits: commits.slice(position).map(line => line.split(" ")[0]) }); break;
    }
    const next = historicalRows(sha);
    if (!next) { previous = null; continue; }
    for (const row of Object.keys(next)) if (previous && !previous[row] && rowFirstSeen[row] === undefined) rowFirstSeen[row] = Number(seconds) * 1000;
    for (const [row, value] of Object.entries(previous || {})) if (next[row]?.outcome !== value.outcome) {
      changes.push({ row, sha, at: Number(seconds) * 1000, before: value.outcome, after: next[row]?.outcome || null });
    }
    previous = next;
  }
  return { rowFirstSeen, outcomeHistory: { parserVersion: 2, base: base || null, changes, errors, commits: commits.map(line => line.split(" ")[0]) } };
}
