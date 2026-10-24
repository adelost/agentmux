// Dream command: one configured, compacted fleet curator plus session housekeeping.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from "fs";
import { dirname, join } from "path";
import { createHash } from "node:crypto";
import { findChannelForPane, listAgents, loadConfig } from "./config.mjs";
import { notifyUser, sendToChannelId } from "./send-notify.mjs";
import { getPaneStatus, sendToPane } from "./tmux.mjs";
import { parseSinceArg } from "../core/jsonl-reader.mjs";
import { formatJanitorResult, trimAgedSessions } from "../core/janitor.mjs";
import {
  defaultDreamReceiptPath, readDreamReceipts, recordDreamReceipts,
} from "../core/dream-eligibility.mjs";
import {
  buildDreamBatch, collectDreamSources, DREAM_PROMPT_BYTES,
} from "../core/dream-summarizer.mjs";
import {
  dreamOwnerPrompt, dreamSummaryBody, resolveDreamCandidates,
  writeDreamOwnerInput,
} from "../core/dream-owner.mjs";
import { archiveNightDay } from "../core/memory-archive.mjs";
import { prepareDreamOwner, selectIdleOwner } from "./dream-curator.mjs";
export { dreamCandidateBlocker } from "./dream-curator.mjs";
import { defaultWorkspace } from "../core/runtime-defaults.mjs";
import { runNightlyCompact } from "./nightly-compact.mjs";
import { waitForDreamOwnerResult } from "../core/dream-result.mjs";
import { recoverDreamRun } from "../core/dream-recovery.mjs";
import { acquireDreamLock } from "../core/dream-lock.mjs";
import { claimScheduledDream } from "../core/dream-schedule.mjs";
import { commitDreamProduct, writeDreamAtomic } from "../core/dream-commit.mjs";
import { protectedDreamBlocks } from "../core/dream-memory-guard.mjs";
import { assertDreamWritePath } from "../core/dream-memory-effects.mjs";
import { notifyDreamFailure } from "../core/dream-failure-notice.mjs";
import { checkDreamCuration } from "../core/dream-curation-check.mjs";
import { readDreamCurationProof } from "../core/dream-curation-proof.mjs";
import { enterDreamSandbox, finishDreamSandbox } from "../core/dream-sandbox.mjs";
import { readDreamPaneHistory } from "../core/dream-history.mjs";
import { dreamShadow, formatDreamShadow, memoizeHistory, writeDreamShadow } from "../core/dream-shadow.mjs";
import { readWindow } from "../core/ask-ledger.mjs";
import { DREAM_CATCH_UP_MS } from "../core/dream-turn-selection.mjs";
import { readDreamMemoryWarnings } from "../core/dream-repair-plan.mjs";
import { finishDreamMemoryRepairs } from "../core/dream-memory-repairs.mjs";
export { commitDreamProduct } from "../core/dream-commit.mjs";
export { isPidAlive } from "../core/dream-lock.mjs";
export { waitForDreamOwnerResult } from "../core/dream-result.mjs";

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
  assertDreamWritePath(memPath);
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
  writeDreamAtomic(path, content.endsWith("\n") ? content : `${content}\n`);
}

function upsertDailyMarker(memPath, dateKey, block, blockRe) {
  ensureDreamDailyFile(memPath, dateKey);
  const failed = new RegExp(String.raw`\n?<!-- amux-dream-failed:${escapeRegExp(dateKey)} [^\n]*-->\n(?:> DIGEST SAKNAS[^\n]*\n)?`, "g");
  let content = readFileSync(memPath, "utf8").replace(blockRe, "\n").replace(failed, "\n");
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

/** WHAT: Makes the day this night covered read as its summary. WHY: A failed move leaves the notes in place for the next nightly archive, so it warns instead of failing the saved night. */
function archiveCoveredDay(workspace, dateKey, summary, now) {
  try {
    const { archived, reason } = archiveNightDay(workspace, dateKey, { summary, now });
    if (archived) console.log(`Dream: ${dateKey} now holds the night's summary; the notes are in ${archived.archivePath}.`);
    else console.log(`Dream: ${dateKey} keeps its notes (${reason}).`);
  } catch (error) {
    console.warn(`Dream: ${dateKey} keeps its notes; archive failed: ${error.message}`);
  }
}

function previousDateKey(dateKey) {
  const atNoonUtc = new Date(`${dateKey}T12:00:00Z`);
  atNoonUtc.setUTCDate(atNoonUtc.getUTCDate() - 1);
  return atNoonUtc.toISOString().slice(0, 10);
}

/** WHAT: Routes the exact instruction synchronously. WHY: Prevents Dream from acting through an invisible brief. */
export async function mirrorDreamOwnerPrompt(ctx, owner, prompt, {
  findChannel = findChannelForPane, send = sendToChannelId,
} = {}) {
  const channelId = findChannel(ctx.configPath, owner.agent, owner.pane);
  if (!channelId) throw new Error(`dream-owner-channel-missing:${owner.agent}:${owner.pane}`);
  const receipts = await send(channelId, `[dream] ${prompt}`, { kind: "mirror" });
  if (!Array.isArray(receipts) || receipts.length === 0) {
    throw new Error(`dream-owner-prompt-mirror-unverified:${owner.agent}:${owner.pane}`);
  }
  return { channelId, messages: receipts.length };
}


/** WHAT: Builds one fleet summary. WHY: Keeps editorial judgment visible while AMUX owns the memory write. */
export async function cmdDream(ctx, flags = {}, dependencies = {}) {
  try { return await runDream(ctx, flags, dependencies); }
  catch (error) {
    if (!flags.dry && !flags.recover && !flags.help && !flags.h) {
      try {
        const dateKey = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(dependencies.now || new Date());
        await notifyDreamFailure({ dateKey, reason: error?.message, notify: dependencies.notifyUser || notifyUser });
      } catch (noticeError) { console.error(`Dream: failure notification unverified: ${noticeError.message}`); }
    }
    throw error;
  }
}

async function runDream(ctx, flags, dependencies) {
  if (flags.help || flags.h) {
    console.log("Usage: amux dream [--quiet] [--dry] [--since 24h|ISO] [--workspace PATH] [--defer-sentinel]");
    console.log("Finish an existing run without a model turn: --recover INPUT.json --source-sha256 SHA [--memory-sha256 PRE_RUN_SHA] [--dry]");
    console.log("Explicit historical import only: add --import-historical; missing original effects stay unattested, failures and cursors unchanged.");
    return { help: true };
  }
  if (flags.recover) {
    const lock = flags.dry ? { acquired: true, release() {} } : acquireDreamLock();
    if (!lock.acquired) return { skipped: "lock-held" };
    try {
      const result = await recoverDreamRun(ctx, flags, { commit: commitDreamProduct });
      if (result.recovered) {
        const time = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit" }).format(new Date());
        writeDreamRunSentinel(result.path, result.dateKey, time, result.included, result.unreadable);
        if (result.unreadable) process.exitCode = 1;
      }
      console.log(JSON.stringify(result));
      return result;
    } finally { lock.release(); }
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
    || defaultWorkspace(process.env.HOME);
  if (process.env.AMUX_SCHEDULED_DREAM_DATE && process.env.AMUX_SCHEDULED_DREAM_DATE !== dateKey) {
    console.log("Dream skipped: scheduled-date-changed");
    return { skipped: "scheduled-date-changed" };
  }
  const memPath = join(workspaceDir, "memory", `${dateKey}.md`);
  const agents = dependencies.agents || listAgents(ctx.configPath);
  const runtimeConfig = dependencies.runtimeConfig || loadConfig(ctx.configPath);
  const candidates = dependencies.candidates
    || (dependencies.owner ? [dependencies.owner] : resolveDreamCandidates(runtimeConfig));
  let owner = candidates[0];
  const primarySource = process.env.AMUX_DREAM_SOURCE || "conversation-log";
  if (!["conversation-log", "raw"].includes(primarySource)) throw Error(`Unknown AMUX_DREAM_SOURCE '${primarySource}'; use conversation-log or raw`);
  const readConversation = dependencies.readConversation || (dependencies.collectSources
    ? () => ({ asks: [], posts: [], coverageStartMs: Infinity }) : readWindow);
  // Production reads are cached so the shadow's journal fallback reuses them.
  const readHistory = dependencies.collectSources ? null : memoizeHistory(readDreamPaneHistory);
  const collect = () => {
    const receipts = readReceipts(receiptPath);
    const observed = collectSources(agents, since.getTime(), { receipts, ...(readHistory ? { readHistory } : {}),
      ...(primarySource === "raw" ? {} : { conversation: { log: readConversation({ since: since.getTime() - DREAM_CATCH_UP_MS }) } }) });
    for (const skipped of observed.skipped || []) {
      if (skipped.reason === "active-turn-deferred") {
        console.log(`Dream: ${skipped.agent}:${skipped.pane} has ${skipped.deferredTurns} active turn(s) deferred; cursor unchanged.`);
      }
    }
    const memoryRepair = primarySource === "raw"
      ? (dependencies.readMemoryWarnings || readDreamMemoryWarnings)(workspaceDir, { now }) : { warnings: [], omitted: 0 };
    const repairBytes = memoryRepair.warnings.length || memoryRepair.omitted ? Buffer.byteLength(JSON.stringify({ memoryRepair })) + 1 : 0;
    const batch = buildDreamBatch(observed.sources, dateKey, { ...dependencies.batchOptions,
      maxPromptBytes: (dependencies.batchOptions?.maxPromptBytes || DREAM_PROMPT_BYTES) - repairBytes });
    if (repairBytes) { batch.payload.memoryRepair = memoryRepair; batch.sourceText = JSON.stringify(batch.payload); }
    return { receipts, observed, batch };
  };
  // The conversation-log shadow only compares; a failure never stops Dream.
  const shadow = ({ receipts, observed, batch }) => {
    const run = dependencies.shadow || (primarySource === "raw" && readHistory && dreamShadow);
    if (!run) return null;
    try {
      return { ...run({ agents, sinceMs: since.getTime(), receipts, readHistory, current: { observed, batch }, dateKey, nowMs: now.getTime() }), primarySource };
    } catch (error) {
      console.warn(`Dream shadow on the conversation log failed: ${error.message}`);
      return null;
    }
  };

  if (flags.dry) {
    const { receipts, observed, batch } = collect();
    const shadowReport = shadow({ receipts, observed, batch });
    await (dependencies.nightlyCompact || runNightlyCompact)(ctx, flags, { agents, runtimeConfig });
    console.log(`Dream owner: ${owner.agent}:${owner.pane} (${owner.engine}).`);
    console.log(`Dream source: ${primarySource}. Raw retreat: AMUX_DREAM_SOURCE=raw.`);
    if (candidates.length > 1) {
      console.log(`Configured fallbacks, tried in order: ${candidates.slice(1)
        .map((candidate) => `${candidate.agent}:${candidate.pane} (${candidate.engine})`).join(", ")}.`);
    }
    console.log(`Dream would verify /compact, then send one visible prompt for ${batch.included.length} pane(s).`);
    console.log(`Input packet: ${Buffer.byteLength(JSON.stringify(batch.payload))} bytes; no hidden model process.`);
    if (batch.payload.memoryRepair) console.log(`Memory repair: ${batch.payload.memoryRepair.warnings.length} warning(s), ${batch.payload.memoryRepair.warnings.filter(row => row.editable).length} eligible; proposals only, no memory writes.`);
    for (const source of batch.included) {
      const waiting = `${source.omittedTurns ? `, ${source.omittedTurns} omitted` : ""}${source.deferredTurns ? ", 1 still running" : ""}`;
      const gap = source.historyComplete === false ? ", history before the window start unread" : "";
      console.log(`- ${source.agent}:${source.pane} ${source.engine}, ${source.turns} real turn(s)${waiting}${gap}, cursor ${source.activityCursor}`);
    }
    for (const source of batch.omitted) console.log(`- OMIT ${source.agent}:${source.pane}: ${source.omitReason}`);
    for (const source of observed.unreadable) console.log(`- UNREADABLE ${source.agent}:${source.pane}: ${source.reason}`);
    for (const source of observed.skipped || []) console.log(`- SKIP ${source.agent}:${source.pane}: ${source.reason}`);
    if (shadowReport) console.log(`\n${formatDreamShadow(shadowReport).join("\n")}`);
    console.log("\nVisible prompt template:\n");
    console.log(dreamOwnerPrompt({
      owner,
      input: {
        path: "<durable-local-input>", outputPath: "<isolated-summary-output>",
        sha256: "<sha256>", bytes: 0, runId: "<run-id>",
        memoryFormat: primarySource === "raw" ? 2 : 3,
        memoryRepair: !!batch.payload.memoryRepair,
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
  let runMaintenance = true;
  let committedInput = null;
  try {
    if (process.env.AMUX_SCHEDULED_DREAM_DATE) {
      // Recheck under the manual controller's lock, not just before spawn.
      const admission = claimScheduledDream(workspaceDir, dateKey, { now,
        token: process.env.AMUX_SCHEDULED_DREAM_TOKEN, mode: process.env.AMUX_SCHEDULED_DREAM_MODE,
        since: since.toISOString() });
      if (admission.skipped) {
        runMaintenance = false;
        console.log(`Dream skipped: ${admission.skipped}`);
        return admission;
      }
    }
    const { receipts, observed, batch } = collect();
    const shadowReport = shadow({ receipts, observed, batch });
    if (shadowReport) {
      try { console.log(`${formatDreamShadow(shadowReport).join("\n")}\nShadow report: ${writeDreamShadow(shadowReport)}`); }
      catch (error) { console.warn(`Dream shadow report not saved: ${error.message}`); }
    }
    if (!batch.included.length && !batch.payload.memoryRepair) {
      if (!flags.quiet && !flags.q) console.log("Dream: no new journal-backed work; owner pane untouched.");
      if (!flags.deferSentinel && !flags["defer-sentinel"]) {
        writeDreamRunSentinel(memPath, dateKey, timeStr, 0, observed.unreadable.length);
      }
      if (observed.unreadable.length) process.exitCode = 1;
      return { included: [], omitted: batch.omitted, unreadable: observed.unreadable };
    }

    {
      const selection = await selectIdleOwner(ctx, candidates, {
        capable: candidate => candidate.engine === "codex" || !!dependencies.enterSandbox,
        ensureReady: (agent, pane) => ctx.agent.ensureReady(agent, pane),
        prepare: (candidate) => prepareDreamOwner(ctx, candidate, dependencies),
        attempts: dependencies.idleAttempts,
        pollMs: dependencies.idlePollMs,
        sleep: dependencies.sleep,
        getStatus: dependencies.getStatus,
      });
      if (!selection.owner) throw selection.lastError || new Error(`dream-owner-not-idle:${selection.skipped.join(",")}`);
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
      const { compact, quality } = selection;

      ensureDreamDailyFile(memPath, dateKey);
      const memoryBefore = readFileSync(memPath, "utf8");
      const memoryReadAt = Date.now();
      const input = (dependencies.writeInput || writeDreamOwnerInput)({
        schemaVersion: 1,
        memoryFormat: primarySource === "raw" ? 2 : 3,
        dateKey,
        createdAt: now.toISOString(),
        workspace: workspaceDir,
        memoryBeforeSha256: createHash("sha256").update(memoryBefore).digest("hex"),
        memoryGuard: { readAt: new Date(memoryReadAt).toISOString(), blocks: protectedDreamBlocks(memoryBefore), effects: true, sandbox: true,
          paneDirs: [...new Set([owner.paneDir, ...agents.flatMap(agent => (agent.panes || []).map((_, pane) => join(agent.dir, ".agents", String(pane))))].filter(Boolean))] },
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
      const sandboxProof = await (dependencies.enterSandbox || enterDreamSandbox)(ctx, owner, input, compact, quality);
      const finishSandbox = () => (dependencies.finishSandbox || finishDreamSandbox)(ctx, owner, input);
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
      // Enqueue/submit is not completion, but a late transport receipt must not
      // discard a curator already working. The exact final product below is
      // still mandatory; wait for it without sending or compacting again.
      if (!sent?.delivered || sent.unverified) {
        throw new Error(`dream-owner-prompt-unverified:${sent?.reason || sent?.queueState || "unknown"}`);
      }
      let product = await (dependencies.waitForResult || waitForDreamOwnerResult)({
        ctx, owner, prompt, outputPath: input.outputPath, dateKey, runId: input.runId,
        sourceSha256: input.sha256,
        attempts: dependencies.resultAttempts,
        pollMs: dependencies.resultPollMs,
        sleep: dependencies.sleep,
        getStatus: async candidate => (dependencies.getStatus || getPaneStatus)(ctx, candidate.agent, candidate.pane),
        sandboxDenial: async () => {
          try {
            const proof = await (dependencies.getProof || readDreamCurationProof)({ owner, sessionId: compact.sessionId, prompt, dateKey, runId: input.runId, memPath, quality });
            if (proof.sandboxDenied) { finishSandbox(); return true; }
          } catch { /* A partial native turn cannot attest a denial or completion. */ }
          return false;
        },
      });
      if (!product.ok) {
        // Candidate fallback is preparation-only. One dispatched curation is
        // the nightly limit, even if that model cannot finish its response.
        throw new Error(`dream-owner-product-invalid:${product.reason}`);
      }
      const checked = await checkDreamCuration({ owner, sessionId: compact.sessionId, prompt, dateKey, input, memPath,
        quality, workspace: workspaceDir, memoryBefore, getProof: dependencies.getProof, sandboxProof, onTerminal: finishSandbox });
      const { judgeConcurrentNotes } = checked;
      product = finishDreamMemoryRepairs({ workspace: workspaceDir, input, product: checked.product });
      commitDreamProduct({ memPath, memoryBefore, product, dateKey, included: batch.included,
        memoryGuardBlocks: protectedDreamBlocks(memoryBefore),
        omitted: batch.omitted, receipts, receiptPath, now, recordReceipts, input, unreadable: observed.unreadable,
        judgeConcurrentNotes });

      if (!flags.deferSentinel && !flags["defer-sentinel"]) {
        writeDreamRunSentinel(memPath, dateKey, timeStr, batch.included.length, observed.unreadable.length);
      }
      if (batch.omitted.length) console.warn(`Dream: ${batch.omitted.length} pane(s) omitted by fixed limits; receipts unchanged.`);
      if (observed.unreadable.length) {
        console.warn(`Dream: ${observed.unreadable.length} pane journal(s) unreadable; receipts unchanged.`);
        process.exitCode = 1;
      }
      if (!observed.unreadable.length && !flags.deferSentinel && !flags["defer-sentinel"]) {
        committedInput = input;
        archiveCoveredDay(workspaceDir, previousDateKey(dateKey), dreamSummaryBody(product.content), now);
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
    }
  } catch (error) {
    // The run is still hard-failed and rethrown: no hidden pane may take over
    // curation. Only the record of the gap is added, by the controller itself.
    try { writeDreamGapMarker(memPath, dateKey, timeStr, error?.message); }
    catch (markerError) {
      console.error(`Dream: could not record the gap marker: ${markerError.message}`);
    }
    throw error;
  } finally {
    try {
      const maintenance = runMaintenance && await (dependencies.nightlyCompact || runNightlyCompact)(ctx, flags,
        { agents, runtimeConfig, dreamInput: committedInput });
      if (maintenance?.unresolved) { console.error(`Nightly compact unresolved: ${maintenance.unresolved}`); process.exitCode = 1; }
    }
    catch (error) { console.error(`Nightly compact failed: ${error.message}`); process.exitCode = 1; }
    finally { if (runMaintenance) runDreamJanitor(flags); lock.release(); }
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
