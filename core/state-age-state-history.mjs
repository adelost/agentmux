import { spawn, execFileSync } from "node:child_process";
import { stateAgeRows } from "./state-age-rows.mjs";
import { stateAgeOwners, stateAgeWord } from "./state-age-guard.mjs";

/** WHAT: Reads ledger revisions through one bounded Git stream. WHY: Avoids buffering the entire history or spawning a Git process per revision. */
async function* ledgerRevisions(project, commits) {
  const child = spawn("git", ["-C", project.root, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
  let errors = "", buffer = Buffer.alloc(0), size = null, index = 0;
  child.stderr.on("data", data => { errors += data.toString(); });
  const completed = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", code => code ? reject(Error(errors || `git cat-file exited${code}`)) : resolve()); });
  completed.catch(() => {});
  child.stdin.end(commits.map(c => `${c.sha}:${project.ledger}\n`).join(""));
  try {
    for await (const chunk of child.stdout) {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (size === null) {
          const end = buffer.indexOf(10); if (end < 0) break;
          const header = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 1);
          if (header.endsWith(" missing")) { yield { ...commits[index++], text: "" }; continue; }
          const found = /^[a-f\d]+ blob (\d+)$/u.exec(header);
          if (!found) throw Error(`Unreadable historical ledger: ${header}`);
          size = Number(found[1]);
        }
        if (buffer.length < size + 1) break;
        const text = buffer.subarray(0, size).toString("utf8"); buffer = buffer.subarray(size + 1); size = null;
        yield { ...commits[index++], text };
      }
    }
    await completed;
    if (index !== commits.length || size !== null || buffer.length) throw Error("Historical ledger stream incomplete");
  } finally { if (child.exitCode === null) child.kill(); }
}

/** WHAT: Builds state-word clocks at selected default-branch revisions. WHY: Prevents checkpoint and assigned-owner edits from hiding stalled work. */
export async function stateAgeClockHistory(project, tip, wanted = new Set()) {
  const lines = execFileSync("git", ["-C", project.root, "log", "--first-parent", "--reverse", "--format=%H %ct", tip, "--", project.ledger],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).trim().split("\n").filter(Boolean);
  const commits = lines.map(line => { const [sha, seconds] = line.split(" "); return { sha, at: Number(seconds) * 1000 }; });
  let previous = new Map();
  const snapshots = new Map();
  for await (const revision of ledgerRevisions(project, commits)) {
    const rows = stateAgeRows(revision.text), next = new Map();
    const counts = new Map();
    for (const row of rows) counts.set(row.row, (counts.get(row.row) || 0) + (stateAgeWord(row.state) === "done" ? 0 : 1));
    for (const row of rows) {
      const word = stateAgeWord(row.state), old = previous.get(row.row);
      if (word === "done" && counts.get(row.row) > 0) continue;
      if (counts.get(row.row) > 1) { next.set(row.row, { word: "ambiguous" }); continue; }
      const owner = stateAgeOwners(row.owner).sort().join(",");
      const changed = !old || old.word !== word;
      const stateChangedAt = old?.word === "ambiguous" ? null : changed ? revision.at : old.stateChangedAt;
      const stateSourceSha = changed ? revision.sha : old.stateSourceSha;
      const lostOwner = !owner && (!old || old.owner !== owner);
      const unownedAt = owner || old?.word === "ambiguous" ? null : lostOwner ? revision.at : old.unownedAt;
      const ownerSourceSha = owner ? null : lostOwner ? revision.sha : old.ownerSourceSha;
      next.set(row.row, { word, owner, stateChangedAt, stateSourceSha, unownedAt, ownerSourceSha });
    }
    previous = next;
    if (wanted.has(revision.sha) || revision.sha === commits.at(-1)?.sha) snapshots.set(revision.sha, rows.map(row => {
      const clock = next.get(row.row), noOwner = stateAgeOwners(row.owner).length === 0;
      const unownedClock = Math.max(clock?.unownedAt ?? -Infinity, clock?.stateChangedAt ?? -Infinity);
      const changedAt = stateAgeWord(row.state) === "open" && noOwner ? (Number.isFinite(unownedClock) ? unownedClock : null) : clock?.stateChangedAt;
      return { ...row, stateChangedAt: clock?.stateChangedAt ?? null, stateSourceSha: clock?.stateSourceSha || null,
        ownerSourceSha: clock?.ownerSourceSha || null, changedAt: changedAt ?? null };
    }));
  }
  return { commits, snapshots };
}
