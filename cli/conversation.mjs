import { readWindow } from "../core/ask-ledger.mjs";
import { readAskBindings } from "../core/ask-bindings.mjs";
import { conversationAskEntries, conversationGroups, formatConversationGroups } from "../core/conversation-view.mjs";
import { filterAskEntries, summarizeAskEntries } from "../core/ask-history.mjs";
import { parseSinceArg } from "../core/jsonl-reader.mjs";
import { getAgent, listAgents, resolveAgent, validateAgentPane } from "./config.mjs";
import { formatAskEntry } from "./ask-format.mjs";
import { formatAskOverview } from "./ask-overview.mjs";

function windowOptions(flags, fallback = "7d") {
  const since = flags.all ? null : parseSinceArg(flags.since || fallback);
  if (!flags.all && !since) throw Error(`invalid --since '${flags.since}'`);
  return { since, grep: flags.grep ? new RegExp(flags.grep, "iu") : null };
}

/** WHAT: Reads a pane's canonical conversation without a live engine. WHY: Keeps stopped panes readable and raw journals an explicit diagnostic. */
export function cmdConversationLog(name, flags, ctx) {
  const pane = flags.p || 0;
  const { since, grep } = windowOptions(flags);
  const limit = flags.n ?? 3, maxBytes = flags["max-bytes"] ?? 65536;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw Error("-n must be between1 and1000");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 1048576) throw Error("--max-bytes must be between1024 and1048576");
  const log = readWindow({ since, agents: [name] });
  let groups = conversationGroups(log, name, pane);
  if (grep) groups = groups.filter(group => group.some(row => grep.test(row.verbatim || row.text || "")));
  groups = groups.slice(-limit);
  console.log(`Conversation log: ${name}:${pane}, since ${since?.toISOString() || "all"}. Raw engine diagnostics: --raw.`);
  console.log(groups.length ? formatConversationGroups(groups, { maxBytes }) : "(no conversation rows; widen --since or use --raw for engine diagnostics)");
}

/** WHAT: Reads ask status and whole reply evidence from canonical posts. WHY: Keeps raw journal formats out of normal orchestration. */
export function cmdConversationAsks(flags, positional, ctx) {
  const { since, grep } = windowOptions(flags);
  const name = flags.agent || positional[0];
  const agent = name ? resolveAgent(name, ctx.configPath) : null;
  const pane = flags.pane ?? flags.p;
  if (pane != null && !agent) throw Error("--pane requires an agent");
  if (agent && !flags["all-repos"]) getAgent(ctx.configPath, agent);
  if (agent && pane != null && !flags["all-repos"]) validateAgentPane(ctx.configPath, agent, pane);
  const configured = new Set(listAgents(ctx.configPath).map(row => row.name));
  const log = readWindow({ since, agents: agent ? [agent] : null });
  const entries = conversationAskEntries(log, { bindings: readAskBindings() }).filter(row => (pane == null || row.pane === pane)
    && (flags["all-repos"] || configured.has(row.agent)));
  const overview = !flags.full && !flags.list && !flags.summary && !flags.grep && pane == null && flags.n == null;
  const rows = filterAskEntries(entries, { sinceMs: since?.getTime(), grep, openOnly: flags.open,
    humanOnly: !flags["all-sources"], limit: flags.summary || overview ? null : flags.n || 40 });
  console.log("\nAsks (conversation log; posted output is evidence of an answer, not of task completion)");
  if (!rows.length) return console.log("(no asks match)");
  if (overview) return console.log(formatAskOverview(rows, { perAgent: flags["per-agent"] || 3 }));
  if (flags.summary) {
    for (const group of summarizeAskEntries(rows)) console.log(`${group.repo}: ${group.total} asks, ${group.open} unresolved`);
    return;
  }
  for (const row of rows) console.log("\n" + formatAskEntry(row, { fullReply: flags.full }));
}
