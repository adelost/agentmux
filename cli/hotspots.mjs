import { formatReflectionBrief, functionKey, latestVerdict, verdictEntry } from "../core/hotspots.mjs";
import {
  appendLedger, changedHotspotsDue, headFunctions, hotspotRepo, ledgerPath, readLedger, repoHotspots, withChurn,
} from "../core/hotspots-repo.mjs";

function usage() {
  return `Usage:
  amux churn functions [--top N] [--json] [--repo DIR]
      Functions hot on trunk, hottest first, with their latest verdict.
  amux churn check [--repo DIR]
      Changed hot functions that still need a verdict; exits 1 with the review brief.
  amux churn verdict '<path>::<name>' REWRITE|SPLIT|KEEP "<why, one sentence>" [--repo DIR]
      Record a reflection. It stays current until the function gets more trunk commits.
  amux churn [path] [--days N] ...
      The file-level WARN-only report (young tests, often rewritten files).

A function is hot at 6+ trunk commits among its lines in 60 days. Per repo:
git config amux.hotspots.minChurn|windowDays|reopenAfter <n>.
Claude panes hit \`check\` automatically on git commit (PreToolUse hook).`;
}

function parseArgs(argv) {
  const positional = [];
  const flags = { repo: process.cwd(), top: 25, json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") flags.json = true;
    else if (arg === "--repo") flags.repo = argv[++index];
    else if (arg === "--top") {
      const value = argv[++index];
      if (!/^\d+$/u.test(value || "")) throw new Error("--top requires a positive integer");
      flags.top = Number(value);
    } else if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg.startsWith("--")) throw new Error(`unknown amux churn option ${arg}`);
    else positional.push(arg);
  }
  if (!flags.repo) throw new Error("--repo requires a directory");
  return { positional, flags };
}

function requireRepo(dir) {
  const repo = hotspotRepo(dir);
  if (!repo) throw new Error(`${dir} is not a git checkout with a trunk (origin/HEAD, main or master)`);
  return repo;
}

function verdictState(ledger, hotspot) {
  const verdict = latestVerdict(ledger, functionKey(hotspot));
  if (!verdict) return "no verdict";
  const since = hotspot.churn - verdict.churn;
  return `${verdict.verdict} ${verdict.at.slice(0, 10)}${since > 0 ? `, +${since} commits since` : ""}`;
}

async function list(repo, flags) {
  const ledger = readLedger(repo);
  const hot = (await repoHotspots(repo)).slice(0, flags.top);
  if (flags.json) {
    console.log(JSON.stringify(hot.map((fn) => ({ ...fn, verdict: latestVerdict(ledger, functionKey(fn)) })), null, 2));
    return hot;
  }
  console.log(`${repo.key} · trunk ${repo.trunk} · hot = ${repo.policy.minChurn}+ commits in ${repo.policy.windowDays} days`);
  if (!hot.length) console.log("no hot functions");
  for (const fn of hot) {
    console.log(`${String(fn.churn).padStart(3)} commits ${String(fn.fixes).padStart(2)} fixes  ${fn.path}:${fn.start} ${fn.name}  [${verdictState(ledger, fn)}]`);
  }
  return hot;
}

async function check(repo) {
  const due = await changedHotspotsDue(repo);
  if (!due.length) {
    console.log("no hotspot reflection due");
    return due;
  }
  console.error(formatReflectionBrief(due, repo.policy));
  process.exitCode = 1;
  return due;
}

async function recordVerdict(repo, positional) {
  const [key, verdict, ...reasonWords] = positional;
  const match = /^(.+)::(.+)$/u.exec(key || "");
  if (!match || !verdict) throw new Error(usage());
  const [, path, name] = match;
  const fileFunctions = headFunctions(repo, [path]);
  const candidates = fileFunctions.filter((fn) => fn.name === name);
  if (!candidates.length) throw new Error(`no function ${name} in ${path} at HEAD`);
  const hotspot = (await withChurn(repo, candidates, fileFunctions)).sort((a, b) => b.churn - a.churn)[0];
  const entry = verdictEntry({
    hotspot, verdict, reason: reasonWords.join(" "), repo: repo.key, headSha: repo.headSha,
    by: process.env.TMUX_PANE ? `${process.env.AMUX_AGENT || "pane"}${process.env.TMUX_PANE}` : process.env.USER || null,
  });
  appendLedger(repo, entry);
  console.log(`recorded ${entry.verdict} for ${entry.key} at ${entry.churn} commits (${ledgerPath(repo)})`);
  return entry;
}

export async function cmdHotspots(argv) {
  const { positional, flags } = parseArgs(argv);
  if (flags.help) {
    console.log(usage());
    return null;
  }
  const [action, ...rest] = positional;
  const repo = requireRepo(flags.repo);
  if (action === "functions") return list(repo, flags);
  if (action === "check") return check(repo);
  if (action === "verdict") return recordVerdict(repo, rest);
  throw new Error(usage());
}
