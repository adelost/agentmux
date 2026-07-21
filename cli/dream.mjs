// Dream command: one bounded stateless fleet summary plus session housekeeping.

import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { listAgents } from "./config.mjs";
import { parseSinceArg } from "../core/jsonl-reader.mjs";
import { formatJanitorResult, pruneOldSessions } from "../core/janitor.mjs";
import {
  defaultDreamReceiptPath, readDreamReceipts, recordDreamReceipts,
} from "../core/dream-eligibility.mjs";
import {
  buildDreamBatch, collectDreamSources, dreamSummaryBlock, runDreamSummarizer,
  upsertDreamSummary, validateDreamSummary,
} from "../core/dream-summarizer.mjs";

const DREAM_LOCK_PATH = () => join(process.env.HOME, ".openclaw", ".dream.lock");

/** WHAT: Checks whether a pid answers signal 0. WHY: Keeps stale locks from suppressing future nights. */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function acquireDreamLock() {
  const lockPath = DREAM_LOCK_PATH();
  mkdirSync(dirname(lockPath), { recursive: true });
  const startedAt = new Date().toISOString();
  const token = `${process.pid}|${startedAt}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, token, { flag: "wx" });
      return {
        acquired: true,
        release() {
          try { if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath); } catch {}
        },
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner = "";
      try { owner = readFileSync(lockPath, "utf8").trim(); } catch {}
      const [pidText, ownerStartedAt = "unknown"] = owner.split("|");
      const ownerPid = Number(pidText);
      if (isPidAlive(ownerPid)) {
        console.log(`Dream skipped: lock-held pid=${ownerPid} started=${ownerStartedAt}`);
        return { acquired: false, release() {} };
      }
      try { unlinkSync(lockPath); } catch {}
    }
  }
  console.log("Dream skipped: lock-held pid=unknown started=unknown");
  return { acquired: false, release() {} };
}

function dailyMemoryHeader(dateKey) {
  return [
    "<!-- template: daily -->",
    `> summary: Daily notes for ${dateKey}, maintained by amux dream.`,
    "> why: Session continuity and nightly fleet activity digest.",
    "",
    `# ${dateKey}`,
    "",
  ].join("\n");
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureDreamDailyFile(memPath, dateKey) {
  mkdirSync(dirname(memPath), { recursive: true });
  if (!existsSync(memPath)) {
    writeFileSync(memPath, dailyMemoryHeader(dateKey));
    return;
  }
  const current = readFileSync(memPath, "utf8");
  if (current.includes("<!-- template: daily -->")
      && /^> summary:/m.test(current) && /^> why:/m.test(current)
      && new RegExp(`^# ${escapeRegExp(dateKey)}$`, "m").test(current)) return;
  const body = current.trimStart().replace(new RegExp(`^# ${escapeRegExp(dateKey)}\s*\n*`), "");
  writeFileSync(memPath, dailyMemoryHeader(dateKey) + body);
}

function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content.endsWith("\n") ? content : `${content}\n`);
  renameSync(temporary, path);
}

function writeDreamRunSentinel(memPath, dateKey, timeStr, okCount, failedCount) {
  ensureDreamDailyFile(memPath, dateKey);
  const sentinel = `<!-- amux-dream-run:${dateKey} ${timeStr} (${okCount} panes ok / ${failedCount} failed) -->`;
  const re = new RegExp(`\n?<!-- amux-dream-run:${escapeRegExp(dateKey)} [^\n]*-->\n?`, "g");
  let content = readFileSync(memPath, "utf8").replace(re, "\n");
  const heading = `# ${dateKey}`;
  const lineEnd = content.indexOf("\n", content.indexOf(heading));
  const at = lineEnd >= 0 ? lineEnd + 1 : content.length;
  content = `${content.slice(0, at)}${sentinel}\n${content.slice(at).replace(/^\n+/, "\n")}`;
  atomicWrite(memPath, content);
}

/** WHAT: Builds one fleet summary. WHY: Keeps Dream from resuming, compacting, sending to, or inspecting tmux panes. */
export async function cmdDream(ctx, flags = {}, dependencies = {}) {
  const readReceipts = dependencies.readReceipts || readDreamReceipts;
  const collectSources = dependencies.collectSources || collectDreamSources;
  const summarize = dependencies.summarize || runDreamSummarizer;
  const recordReceipts = dependencies.recordReceipts || recordDreamReceipts;
  const receiptPath = dependencies.receiptPath || defaultDreamReceiptPath();
  const sinceArg = flags.since || "24h";
  const since = parseSinceArg(sinceArg);
  if (!since) throw new Error(`invalid --since '${sinceArg}'. Use ISO or relative ("24h", "2h", "30min").`);

  const now = dependencies.now || new Date();
  const dateKey = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const timeStr = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  const workspaceDir = flags.workspace || process.env.OPENCLAW_WORKSPACE
    || join(process.env.HOME, ".openclaw", "workspace");
  const memPath = join(workspaceDir, "memory", `${dateKey}.md`);
  const agents = dependencies.agents || listAgents(ctx.configPath);
  const receipts = readReceipts(receiptPath);
  const observed = collectSources(agents, since.getTime(), { receipts });
  const batch = buildDreamBatch(observed.sources, dateKey, dependencies.batchOptions);

  if (flags.dry) {
    console.log(`Dream would run one stateless summarizer for ${batch.included.length} pane(s).`);
    console.log(`Prompt: ${Buffer.byteLength(batch.prompt)} bytes; no pane wake; no /compact.`);
    for (const source of batch.included) {
      console.log(`- ${source.agent}:${source.pane} ${source.engine}, ${source.turns} recent real turn(s), cursor ${source.activityCursor}`);
    }
    for (const source of batch.omitted) console.log(`- OMIT ${source.agent}:${source.pane}: ${source.omitReason}`);
    for (const source of observed.unreadable) console.log(`- UNREADABLE ${source.agent}:${source.pane}: ${source.reason}`);
    runDreamJanitor(flags);
    return { ...observed, ...batch, dryRun: true };
  }

  const lock = acquireDreamLock();
  if (!lock.acquired) return { skipped: "lock-held" };
  try {
    if (!batch.included.length) {
      if (!flags.quiet && !flags.q) console.log("Dream: no new journal-backed work; no model invoked.");
      if (!flags.deferSentinel && !flags["defer-sentinel"]) {
        writeDreamRunSentinel(memPath, dateKey, timeStr, 0, observed.unreadable.length);
      }
      if (observed.unreadable.length) process.exitCode = 1;
      return { included: [], omitted: batch.omitted, unreadable: observed.unreadable };
    }

    if (!flags.quiet && !flags.q) {
      console.log(`Dream: one stateless summary from ${batch.included.length} pane(s), ${Buffer.byteLength(batch.prompt)} prompt bytes.`);
    }
    const generated = await summarize(batch.prompt, { dateKey });
    const valid = validateDreamSummary(generated);
    if (!valid.ok) throw new Error(`dream summary rejected: ${valid.reason}`);
    ensureDreamDailyFile(memPath, dateKey);
    const block = dreamSummaryBlock(valid.content, dateKey, batch.included, batch.omitted);
    atomicWrite(memPath, upsertDreamSummary(readFileSync(memPath, "utf8"), dateKey, block));
    recordReceipts(receipts, batch.included, { path: receiptPath, dateKey, now });

    if (!flags.deferSentinel && !flags["defer-sentinel"]) {
      writeDreamRunSentinel(memPath, dateKey, timeStr, batch.included.length, observed.unreadable.length);
    }
    if (batch.omitted.length) console.warn(`Dream: ${batch.omitted.length} pane(s) omitted by fixed limits; receipts unchanged.`);
    if (observed.unreadable.length) {
      console.warn(`Dream: ${observed.unreadable.length} pane journal(s) unreadable; receipts unchanged.`);
      process.exitCode = 1;
    }
    return { included: batch.included, omitted: batch.omitted, unreadable: observed.unreadable, path: memPath };
  } finally {
    runDreamJanitor(flags);
    lock.release();
  }
}

function runDreamJanitor(flags = {}) {
  if (process.env.AMUX_JANITOR_ENABLED === "false") return;
  try {
    const result = pruneOldSessions({ dryRun: !!flags.dry });
    if ((!flags.quiet && !flags.q) || result.deleted || result.failed) console.log(formatJanitorResult(result));
  } catch (error) {
    console.warn(`janitor skipped: ${error.message}`);
  }
}
