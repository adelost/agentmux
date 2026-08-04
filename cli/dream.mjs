// Dream command: one configured, compacted fleet curator plus session housekeeping.

import {
  existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { findChannelForPane, listAgents, loadConfig } from "./config.mjs";
import { notifyUser, sendToChannelId } from "./send-notify.mjs";
import { getPaneStatus, sendToPane } from "./tmux.mjs";
import { parseSinceArg } from "../core/jsonl-reader.mjs";
import { formatJanitorResult, trimAgedSessions } from "../core/janitor.mjs";
import { latestClaudeSessionIdentity } from "../core/native-session-identity.mjs";
import {
  defaultDreamReceiptPath, readDreamReceipts, recordDreamReceipts,
} from "../core/dream-eligibility.mjs";
import {
  buildDreamBatch, collectDreamSources, dreamSummaryBlock, upsertDreamSummary,
} from "../core/dream-summarizer.mjs";
import {
  dreamOwnerPrompt, readDreamOwnerQuality, readDreamOwnerResult, resolveDreamCandidates,
  writeDreamOwnerInput,
} from "../core/dream-owner.mjs";
import { verifiedClaudeCompact, verifiedCodexCompact } from "../core/verified-compact.mjs";

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
  const body = current.trimStart().replace(new RegExp(`^# ${escapeRegExp(dateKey)}\\s*\\n*`), "");
  writeFileSync(memPath, dailyMemoryHeader(dateKey) + body);
}

function atomicWrite(path, content) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content.endsWith("\n") ? content : `${content}\n`);
  renameSync(temporary, path);
}

function upsertDailyMarker(memPath, dateKey, block, blockRe) {
  ensureDreamDailyFile(memPath, dateKey);
  let content = readFileSync(memPath, "utf8").replace(blockRe, "\n");
  const heading = `# ${dateKey}`;
  const lineEnd = content.indexOf("\n", content.indexOf(heading));
  const at = lineEnd >= 0 ? lineEnd + 1 : content.length;
  content = `${content.slice(0, at)}${block}\n${content.slice(at).replace(/^\n+/, "\n")}`;
  atomicWrite(memPath, content);
}

function writeDreamRunSentinel(memPath, dateKey, timeStr, okCount, failedCount) {
  upsertDailyMarker(
    memPath,
    dateKey,
    `<!-- amux-dream-run:${dateKey} ${timeStr} (${okCount} panes ok / ${failedCount} failed) -->`,
    new RegExp(`\n?<!-- amux-dream-run:${escapeRegExp(dateKey)} [^\n]*-->\n?`, "g"),
  );
}

/**
 * WHAT: Records a failed nightly run inside the daily memory file itself.
 * WHY: A lost night used to be visible only as a MISSING sentinel, and nobody
 * greps for an absence. The gap now states itself in the durable artifact
 * everyone already reads, so it cannot pass as an ordinary quiet day.
 */
export function writeDreamGapMarker(memPath, dateKey, timeStr, reason) {
  const detail = String(reason || "unknown").replace(/[<>]/gu, "").replace(/\s+/gu, " ").trim().slice(0, 200)
    || "unknown";
  upsertDailyMarker(
    memPath,
    dateKey,
    [
      `<!-- amux-dream-failed:${dateKey} ${timeStr} ${detail} -->`,
      `> DIGEST SAKNAS (${timeStr}): ${detail}. Ingen nattlig sammanfattning skrevs for detta dygn.`,
    ].join("\n"),
    new RegExp(`\n?<!-- amux-dream-failed:${escapeRegExp(dateKey)} [^\n]*-->\n(?:> DIGEST SAKNAS[^\n]*\n)?`, "g"),
  );
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function previousDateKey(dateKey) {
  const atNoonUtc = new Date(`${dateKey}T12:00:00Z`);
  atNoonUtc.setUTCDate(atNoonUtc.getUTCDate() - 1);
  return atNoonUtc.toISOString().slice(0, 10);
}

function ownerResponseText(response) {
  return (response?.items || [])
    .filter((item) => item.type === "text")
    .map((item) => String(item.content || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** WHAT: Reads file, response, and idle truth until complete. WHY: Prevents prompt delivery alone from becoming a Dream receipt. */
export async function waitForDreamOwnerResult({
  ctx, owner, prompt, outputPath, dateKey, runId, sourceSha256,
  attempts = 450, pollMs = 2_000, sleep = wait,
}) {
  const expected = `DREAM_OK ${dateKey} ${runId}`;
  let last = { ok: false, reason: "dream-output-missing" };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = readDreamOwnerResult(outputPath, dateKey, runId, owner, sourceSha256);
    if (last.ok) {
      const busy = await ctx.agent.isBusy(owner.agent, owner.pane).catch(() => true);
      const response = await ctx.agent.getResponseStreamWithRaw(
        owner.agent, owner.pane, prompt,
      ).catch(() => null);
      if (!busy && ownerResponseText(response) === expected) return last;
    }
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  return { ok: false, reason: last.reason || "dream-owner-response-missing" };
}

/** WHAT: Routes the exact instruction synchronously. WHY: Prevents Dream from acting through an invisible brief. */
export async function mirrorDreamOwnerPrompt(ctx, owner, prompt, {
  findChannel = findChannelForPane, send = sendToChannelId,
} = {}) {
  const channelId = findChannel(ctx.configPath, owner.agent, owner.pane);
  if (!channelId) throw new Error(`dream-owner-channel-missing:${owner.agent}:${owner.pane}`);
  const receipts = await send(channelId, `[dream] ${prompt}`);
  if (!Array.isArray(receipts) || receipts.length === 0) {
    throw new Error(`dream-owner-prompt-mirror-unverified:${owner.agent}:${owner.pane}`);
  }
  return { channelId, messages: receipts.length };
}

// A pane in one of these states cannot curate tonight no matter how long Dream
// waits: the quota is spent, or a human has to clear something first. Every
// other non-idle state is a pane that is merely busy and will come back.
const CANNOT_CURATE = Object.freeze({
  limited: "quota or rate limited",
  permission: "waiting on a human permission prompt",
  menu: "sitting in a modal menu",
});

/** WHAT: Says why a candidate cannot curate at all, or null if it merely might be busy. WHY: Falling through must follow capability, never momentary load. */
export function dreamCandidateBlocker(status) {
  return CANNOT_CURATE[status] ?? null;
}

/**
 * WHAT: Picks the first configured candidate that can curate, waiting out a busy one.
 * WHY: The list exists because a quota-dead curator cost a whole night, and
 * that is the only thing it may skip for. A candidate that is merely busy keeps
 * the night: handing the digest onward because a pane happened to be mid-turn
 * at 04:00 would make the curator whoever was free, and the memory would wander
 * between panes from night to night. So an incapable candidate is skipped on
 * its first poll, a capable one gets the whole grace period, and a capable one
 * that never settles ends the walk instead of passing the night along.
 */
async function selectIdleOwner(ctx, candidates, { ensureReady, attempts, ...idleOptions } = {}) {
  const skipped = [];
  const reasons = [];
  for (const candidate of candidates) {
    await ensureReady(candidate.agent, candidate.pane);
    const outcome = await waitForOwnerIdle(ctx, candidate, { ...idleOptions, attempts });
    if (outcome.idle) return { owner: candidate, skipped, reasons };
    skipped.push(`${candidate.agent}:${candidate.pane}`);
    reasons.push(`${candidate.agent}:${candidate.pane} ${outcome.blocked || "stayed busy for the whole grace period"}`);
    if (!outcome.blocked) break;
  }
  return { owner: null, skipped, reasons };
}

async function waitForOwnerIdle(ctx, owner, {
  attempts = 120, pollMs = 5_000, sleep = wait, getStatus = getPaneStatus,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await getStatus(ctx, owner.agent, owner.pane).catch(() => "unknown");
    if (status === "idle") return { idle: true, blocked: null };
    // Incapacity is visible on the first poll, so giving every candidate the
    // full grace costs a quota-dead pane nothing.
    const blocked = dreamCandidateBlocker(status);
    if (blocked) return { idle: false, blocked };
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  return { idle: false, blocked: null };
}

function verifyOwnerQuality(owner, context) {
  if (!context?.model || !context?.effort) {
    throw new Error(`dream-owner-quality-unverified:${owner.agent}:${owner.pane}`);
  }
  if (/haiku/iu.test(context.model) || String(context.effort || "").toLowerCase() === "low") {
    throw new Error(`dream-owner-quality-blocked:${context.model}:${context.effort || "unknown-effort"}`);
  }
  return {
    model: String(context.model), effort: String(context.effort),
    sessionId: context.sessionId || null, source: context.source || null,
  };
}

function ownerQuality(owner, dependencies) {
  return dependencies.getContext
    ? dependencies.getContext(owner.paneDir, owner.engine)
    : (dependencies.getQuality || readDreamOwnerQuality)(owner);
}

/** WHAT: Builds one fleet summary. WHY: Keeps editorial judgment visible while AMUX owns the memory write. */
export async function cmdDream(ctx, flags = {}, dependencies = {}) {
  if (flags.help || flags.h) {
    console.log("Usage: amux dream [--quiet] [--dry] [--since 24h|ISO] [--workspace PATH] [--defer-sentinel]");
    return { help: true };
  }
  const readReceipts = dependencies.readReceipts || readDreamReceipts;
  const collectSources = dependencies.collectSources || collectDreamSources;
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
  const runtimeConfig = dependencies.runtimeConfig || loadConfig(ctx.configPath);
  const candidates = dependencies.candidates
    || (dependencies.owner ? [dependencies.owner] : resolveDreamCandidates(runtimeConfig));
  let owner = candidates[0];
  const receipts = readReceipts(receiptPath);
  const observed = collectSources(agents, since.getTime(), { receipts });
  const batch = buildDreamBatch(observed.sources, dateKey, dependencies.batchOptions);

  if (flags.dry) {
    console.log(`Dream owner: ${owner.agent}:${owner.pane} (${owner.engine}).`);
    if (candidates.length > 1) {
      console.log(`Configured fallbacks, tried in order: ${candidates.slice(1)
        .map((candidate) => `${candidate.agent}:${candidate.pane} (${candidate.engine})`).join(", ")}.`);
    }
    console.log(`Dream would verify /compact, then send one visible prompt for ${batch.included.length} pane(s).`);
    console.log(`Input packet: ${Buffer.byteLength(JSON.stringify(batch.payload))} bytes; no hidden model process.`);
    for (const source of batch.included) {
      console.log(`- ${source.agent}:${source.pane} ${source.engine}, ${source.turns} recent real turn(s), cursor ${source.activityCursor}`);
    }
    for (const source of batch.omitted) console.log(`- OMIT ${source.agent}:${source.pane}: ${source.omitReason}`);
    for (const source of observed.unreadable) console.log(`- UNREADABLE ${source.agent}:${source.pane}: ${source.reason}`);
    for (const source of observed.skipped || []) console.log(`- SKIP ${source.agent}:${source.pane}: ${source.reason}`);
    console.log("\nVisible prompt template:\n");
    console.log(dreamOwnerPrompt({
      owner,
      input: {
        path: "<durable-local-input>", outputPath: "<isolated-summary-output>",
        sha256: "<sha256>", bytes: 0, runId: "<run-id>",
      },
      memPath,
      previousMemPath: join(workspaceDir, "memory", `${previousDateKey(dateKey)}.md`),
      dateKey,
      included: batch.included.length,
      omitted: batch.omitted.length,
      unreadable: observed.unreadable.length,
    }));
    runDreamJanitor(flags);
    return { ...observed, ...batch, dryRun: true };
  }

  const lock = acquireDreamLock();
  if (!lock.acquired) return { skipped: "lock-held" };
  try {
    if (!batch.included.length) {
      if (!flags.quiet && !flags.q) console.log("Dream: no new journal-backed work; owner pane untouched.");
      if (!flags.deferSentinel && !flags["defer-sentinel"]) {
        writeDreamRunSentinel(memPath, dateKey, timeStr, 0, observed.unreadable.length);
      }
      if (observed.unreadable.length) process.exitCode = 1;
      return { included: [], omitted: batch.omitted, unreadable: observed.unreadable };
    }

    const selection = await selectIdleOwner(ctx, candidates, {
      ensureReady: (agent, pane) => ctx.agent.ensureReady(agent, pane),
      attempts: dependencies.idleAttempts,
      pollMs: dependencies.idlePollMs,
      sleep: dependencies.sleep,
      getStatus: dependencies.getStatus,
    });
    if (!selection.owner) throw new Error(`dream-owner-not-idle:${selection.skipped.join(",")}`);
    if (selection.skipped.length) {
      const message = `Dream: curator ${selection.reasons.join("; ")};`
        + ` curating with configured fallback ${selection.owner.agent}:${selection.owner.pane}.`;
      console.warn(message);
      try {
        await (dependencies.notifyUser || notifyUser)(message, { level: "warn", title: "amux dream" });
      } catch (error) {
        console.error(`Dream: fallback notification failed: ${error.message}`);
      }
    }
    owner = selection.owner;
    const context = ownerQuality(owner, dependencies);
    verifyOwnerQuality(owner, context);

    const compact = owner.engine === "codex"
      ? await (dependencies.compactCodex || verifiedCodexCompact)({
          agent: ctx.agent, agentName: owner.agent, pane: owner.pane, paneDir: owner.paneDir,
          sleep: dependencies.sleep,
        })
      : await (dependencies.compactClaude || verifiedClaudeCompact)({
          agent: ctx.agent, agentName: owner.agent, pane: owner.pane, paneDir: owner.paneDir,
          latestIdentity: latestClaudeSessionIdentity, sleep: dependencies.sleep,
        });
    if (!compact.ok) throw new Error(`dream-owner-compact-failed:${compact.reason}`);

    const quality = verifyOwnerQuality(
      owner,
      ownerQuality(owner, dependencies),
    );
    if (quality.sessionId && quality.sessionId !== compact.sessionId) {
      throw new Error("dream-owner-quality-session-mismatch");
    }

    ensureDreamDailyFile(memPath, dateKey);
    const memoryBefore = readFileSync(memPath, "utf8");
    const input = (dependencies.writeInput || writeDreamOwnerInput)({
      schemaVersion: 1,
      dateKey,
      createdAt: now.toISOString(),
      owner: { agent: owner.agent, pane: owner.pane, engine: owner.engine },
      compact: {
        sessionId: compact.sessionId, boundary: compact.compactBoundary,
        model: quality.model, effort: quality.effort, qualitySource: quality.source,
      },
      payload: batch.payload,
      omitted: batch.omitted.map(({ agent, pane, engine, omitReason }) => ({ agent, pane, engine, omitReason })),
      unreadable: observed.unreadable,
      skipped: observed.skipped || [],
    });
    const prompt = dreamOwnerPrompt({
      owner,
      input,
      memPath,
      previousMemPath: join(workspaceDir, "memory", `${previousDateKey(dateKey)}.md`),
      dateKey,
      included: batch.included.length,
      omitted: batch.omitted.length,
      unreadable: observed.unreadable.length,
    });
    const visibleMirror = await (dependencies.mirrorPrompt || mirrorDreamOwnerPrompt)(
      ctx, owner, prompt,
    );
    if (!flags.quiet && !flags.q) console.log(prompt);
    const sent = await (dependencies.send || sendToPane)(ctx, owner.agent, owner.pane, prompt, {
      source: "dream",
      idempotencyKey: `dream:${dateKey}:${input.runId}`,
      waitMs: 30_000,
      mirror: false,
    });
    if (!sent?.delivered || sent.pending || sent.unverified) {
      throw new Error(`dream-owner-prompt-unverified:${sent?.reason || sent?.queueState || "unknown"}`);
    }
    const product = await (dependencies.waitForResult || waitForDreamOwnerResult)({
      ctx, owner, prompt, outputPath: input.outputPath, dateKey, runId: input.runId,
      sourceSha256: input.sha256,
      attempts: dependencies.resultAttempts,
      pollMs: dependencies.resultPollMs,
      sleep: dependencies.sleep,
    });
    if (!product.ok) throw new Error(`dream-owner-product-invalid:${product.reason}`);
    if (readFileSync(memPath, "utf8") !== memoryBefore) {
      throw new Error("dream-owner-touched-memory-before-controller-commit");
    }
    const block = dreamSummaryBlock(product.content, dateKey, batch.included, batch.omitted);
    atomicWrite(memPath, upsertDreamSummary(memoryBefore, dateKey, block));
    recordReceipts(receipts, batch.included, { path: receiptPath, dateKey, now });

    if (!flags.deferSentinel && !flags["defer-sentinel"]) {
      writeDreamRunSentinel(memPath, dateKey, timeStr, batch.included.length, observed.unreadable.length);
    }
    if (batch.omitted.length) console.warn(`Dream: ${batch.omitted.length} pane(s) omitted by fixed limits; receipts unchanged.`);
    if (observed.unreadable.length) {
      console.warn(`Dream: ${observed.unreadable.length} pane journal(s) unreadable; receipts unchanged.`);
      process.exitCode = 1;
    }
    return {
      included: batch.included,
      omitted: batch.omitted,
      unreadable: observed.unreadable,
      owner,
      compact,
      visibleMirror,
      input,
      path: memPath,
    };
  } catch (error) {
    // The run is still hard-failed and rethrown: no hidden pane may take over
    // curation. Only the record of the gap is added, by the controller itself.
    try { writeDreamGapMarker(memPath, dateKey, timeStr, error?.message); }
    catch (markerError) {
      console.error(`Dream: could not record the gap marker: ${markerError.message}`);
    }
    throw error;
  } finally {
    runDreamJanitor(flags);
    lock.release();
  }
}

function runDreamJanitor(flags = {}) {
  if (process.env.AMUX_JANITOR_ENABLED === "false") return;
  try {
    const result = trimAgedSessions({ dryRun: !!flags.dry });
    if ((!flags.quiet && !flags.q) || result.trimmed || result.failed) console.log(formatJanitorResult(result));
  } catch (error) {
    console.warn(`janitor skipped: ${error.message}`);
  }
}
