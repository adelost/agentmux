import { readFileSync, writeFileSync } from "node:fs";
import { readWindow, defaultAskLedgerPath } from "../core/ask-ledger.mjs";
import { createClaimSources } from "../core/claim-sources.mjs";
import { checkReply } from "../core/claim-guard.mjs";
import { claimRepoPaths } from "../core/claim-repos.mjs";
import { claimHash, summarizeClaims, qualifyClaims } from "../core/claim-corpus.mjs";
import { claimAlgorithm } from "../core/claim-version.mjs";

const help = `amux claims check --since 24h [--day YYYY-MM-DD] [--output /private/report.json]
  [--known /private/confirmed-groups.json] [--review /private/labels.json]
  [--held-out /private/reviewed-26oct-report.json] [--input /private/frozen-report.json]
  [--ledger PATH] [--repo PATH ...]
Read-only classifier over canonical sent post/reply rows. --day selects a held-out UTC day.
The report retains original IDs, timestamps, text hashes and a reproducible sample of at most50 holds.
Human labels: {corpusSha256, labels:[{id,textSha256,falseStop,reason}]}.
Numbers remain unqualified until both days are graded and the seven groups confirmed.
No source check executes quoted commands. No configuration is changed.`;

/** WHAT: Checks original replies with the live claim policy. WHY: Prevents ungraded detection results from authorizing enforcement. */
export async function cmdClaims(args, { configPath } = {}) {
  if (args.includes("--help") || args[0] !== "check") return console.log(help);
  const flags = {}, repos = [];
  for (let i = 1; i < args.length; i++) {
    const key = args[i];
    if (!["--day", "--since", "--output", "--known", "--review", "--held-out", "--ledger", "--repo", "--input"].includes(key)
      || !args[i + 1] || args[i + 1].startsWith("--")) throw Error(`Unknown or incomplete claims option: ${key}`);
    if (key === "--repo") repos.push(args[++i]); else flags[key.slice(2)] = args[++i];
  }
  if (flags.since && !/^\d+(?:h|m)$/u.test(flags.since)) throw Error("claims --since requires e.g.24h");
  const frozen = flags.input ? JSON.parse(readFileSync(flags.input, "utf8")) : null;
  const now = Date.now(), day = frozen?.day || flags.day || new Date(now).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || !Number.isFinite(start)) throw Error("claims --day requires a UTC date");
  const span = flags.since ? Number(flags.since.slice(0, -1)) * (flags.since.endsWith("h") ? 3600000 : 60000) : 86400000;
  const since = flags.day ? start - 1 : Math.max(start - 1, now - span);
  const until = flags.day ? start + 86400000 - 1 : now;
  const ledger = frozen ? { posts: frozen.rows, sourceErrors: [] }
    : readWindow({ path: flags.ledger || defaultAskLedgerPath(), since, until });
  if (ledger.sourceErrors.length) throw Error(`Claim corpus unreadable: ${JSON.stringify(ledger.sourceErrors)}`);
  const sources = createClaimSources(repos.length ? repos : claimRepoPaths(configPath));
  const seen = new Set();
  const rows = ledger.posts.filter(row => (frozen || row.kind === "reply" && row.status === "sent") && !seen.has(row.id) && seen.add(row.id))
    .map(row => ({ id: row.id, ts: row.ts, agent: row.agent, pane: row.pane, messageId: row.messageId,
      ledgerPath: row.ledgerPath, textSha256: claimHash(row.text), text: row.text, ...checkReply(row.text, sources) }));
  const load = path => path ? JSON.parse(readFileSync(path, "utf8")) : null;
  const summary = { ...summarizeClaims(rows, { known: load(flags.known), review: load(flags.review) }), day, algorithm: claimAlgorithm() };
  const heldOut = load(flags["held-out"]);
  const report = { version: 1, checkedAt: new Date(now).toISOString(), day, window: frozen?.window || { since, until },
    sources: sources.repos, ...summary, eligible: qualifyClaims(summary, heldOut), rows };
  if (flags.output) writeFileSync(flags.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, sample: undefined, eligible: report.eligible, output: flags.output || null }, null, 2));
  return report;
}
