// Dream command subsystem: target selection, sequential pane processing, and housekeeping.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { listAgents } from "./config.mjs";
import { sendToPane } from "./tmux.mjs";
import { latestJsonlMtime, panePathFor, parseSinceArg } from "../core/jsonl-reader.mjs";
import { formatJanitorResult, pruneOldSessions } from "../core/janitor.mjs";

const DREAM_LOCK_PATH = () => join(process.env.HOME, ".openclaw", ".dream.lock");
const DREAM_BLOCKING_STATUSES = new Set([
  "working", "permission", "menu", "resume", "dismiss", "unknown",
  "limited",
]);

function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
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
          try {
            if (readFileSync(lockPath, "utf-8") === token) unlinkSync(lockPath);
          } catch {}
        },
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      let owner = "";
      try { owner = readFileSync(lockPath, "utf-8").trim(); } catch {}
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
    "> why: Session continuity and nightly pane activity digest.",
    "",
    `# ${dateKey}`,
    "",
  ].join("\n");
}

function ensureDreamDailyFile(memPath, dateKey) {
  mkdirSync(dirname(memPath), { recursive: true });
  if (!existsSync(memPath)) {
    writeFileSync(memPath, dailyMemoryHeader(dateKey));
    return;
  }

  const current = readFileSync(memPath, "utf-8");
  if (
    current.includes("<!-- template: daily -->") &&
    /^> summary:/m.test(current) &&
    /^> why:/m.test(current) &&
    new RegExp(`^# ${escapeRegExp(dateKey)}$`, "m").test(current)
  ) {
    return;
  }

  const body = current.trimStart().replace(new RegExp(`^# ${escapeRegExp(dateKey)}\\s*\\n*`), "");
  writeFileSync(memPath, dailyMemoryHeader(dateKey) + body);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeDreamRunSentinel(memPath, dateKey, timeStr, okCount, failedCount) {
  ensureDreamDailyFile(memPath, dateKey);
  const sentinel = `<!-- amux-dream-run:${dateKey} ${timeStr} (${okCount} panes ok / ${failedCount} failed) -->`;
  const sentinelRe = new RegExp(`\\n?<!-- amux-dream-run:${escapeRegExp(dateKey)} [^\\n]*-->\\n?`, "g");
  let content = readFileSync(memPath, "utf-8").replace(sentinelRe, "\n");

  const heading = `# ${dateKey}`;
  const headingIdx = content.indexOf(heading);
  if (headingIdx >= 0) {
    const lineEnd = content.indexOf("\n", headingIdx);
    const insertAt = lineEnd >= 0 ? lineEnd + 1 : content.length;
    content = `${content.slice(0, insertAt)}${sentinel}\n${content.slice(insertAt).replace(/^\n+/, "\n")}`;
  } else {
    content = `${dailyMemoryHeader(dateKey)}${sentinel}\n\n${content.trimStart()}`;
  }
  writeFileSync(memPath, content);
}

function dreamBlockMarkers(t, dateKey) {
  return {
    start: `<!-- amux-dream-${t.agent}-${t.pane}:${dateKey} -->`,
    end: `<!-- /amux-dream-${t.agent}-${t.pane}:${dateKey} -->`,
  };
}

/** WHAT: Checks for one complete pane marker block. WHY: Keeps partial writes from counting as dream output. */
export function hasDreamPaneBlock(content, t, dateKey) {
  const { start, end } = dreamBlockMarkers(t, dateKey);
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  return startIdx >= 0 && endIdx > startIdx;
}

/** WHAT: Checks one pane block against its line budget. WHY: Keeps oversized summaries from passing unnoticed. */
export function validateDreamPaneBlock(content, t, dateKey, maxLines = 10) {
  const { start, end } = dreamBlockMarkers(t, dateKey);
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end, startIdx + start.length);
  if (startIdx < 0 || endIdx < 0) return { ok: false, lines: 0, reason: "marker block missing" };
  const body = content.slice(startIdx + start.length, endIdx);
  const lines = body.split(/\r?\n/).filter((line) => line.trim()).length;
  return lines <= maxLines
    ? { ok: true, lines, reason: null }
    : { ok: false, lines, reason: `${lines} non-empty lines exceeds budget ${maxLines}` };
}

/** WHAT: Tracks one pane block until its bounded deadline. WHY: Keeps delayed writes from being misclassified as missing. */
export async function waitForDreamPaneBlock(memPath, t, dateKey, maxMs = 15_000, pollMs = 1_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (hasDreamPaneBlock(readFileSync(memPath, "utf-8"), t, dateKey)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

/**
 * Poll a pane's status until it has been idle for `idleStreak` consecutive
 * polls, or until maxMs elapses. Returns { idle: bool, status: last }.
 * Only exact `idle` advances: modal/permission/resume/unknown states are
 * blockers because dream sends follow-up prompts and writes shared memory.
 */
async function waitForPaneIdle(ctx, agentName, paneIdx, getStatus,
  maxMs = 300_000, idleStreak = 3, pollMs = 5000) {
  const start = Date.now();
  let streak = 0;
  let last = "unknown";
  while (Date.now() - start < maxMs) {
    last = await getStatus(ctx, agentName, paneIdx).catch(() => "unknown");
    if (last === "idle") streak++;
    else if (DREAM_BLOCKING_STATUSES.has(last)) streak = 0;
    else streak = 0;
    if (streak >= idleStreak) return { idle: true, status: last };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { idle: false, status: last };
}

function isDreamClaudePane(cmd) {
  return String(cmd || "").trim().startsWith("claude");
}

/** WHAT: Checks whether one pane status permits dream work. WHY: Keeps maintenance from interrupting active panes. */
export function isDreamRunnableStatus(status) {
  return status === "idle";
}

/** WHAT: Checks whether one live pane runs Claude. WHY: Keeps incompatible prompt formats out of dream delivery. */
export function isDreamLiveClaudePane(pane) {
  return pane?.command === "claude";
}

/** WHAT: Collects recent idle Claude panes. WHY: Keeps stale or active sessions out of the dream run. */
export async function collectDreamTargets(ctx, agents, sinceMs, opts = {}) {
  const getStatus = opts.getStatus;
  const getMtime = opts.getMtime || latestJsonlMtime;
  const getLivePanes = opts.getLivePanes;
  if (typeof getStatus !== "function" || typeof getLivePanes !== "function") {
    throw new Error("dream target collection requires getStatus and getLivePanes");
  }
  const targets = [];
  const skipped = [];

  for (const a of agents) {
    let livePanes = [];
    try {
      livePanes = await getLivePanes(ctx, a.name);
    } catch {}
    const liveByIndex = new Map((livePanes || []).map((p) => [p.index, p]));
    const panes = Array.isArray(a.panes) ? a.panes : [];
    for (let i = 0; i < panes.length; i++) {
      const cmd = String(panes[i]?.cmd || "");
      if (!isDreamClaudePane(cmd)) continue; // Codex prompt-format differs; claude-only for MVP.
      let lastMs = 0;
      try {
        lastMs = getMtime(panePathFor(a, i)) || 0;
      } catch {}
      if (lastMs < sinceMs) continue;

      const livePane = liveByIndex.get(i);
      const liveCommand = livePane?.command || "missing";
      if (!isDreamLiveClaudePane(livePane)) {
        skipped.push({ agent: a.name, pane: i, lastMs, status: "not-live-claude", liveCommand });
        continue;
      }

      let status = "unknown";
      try {
        status = await getStatus(ctx, a.name, i);
      } catch {}
      const target = { agent: a.name, pane: i, lastMs, status, liveCommand };
      if (isDreamRunnableStatus(status)) targets.push(target);
      else skipped.push(target);
    }
  }

  return { targets, skipped };
}

/** WHAT: Dispatches sequential dream maintenance. WHY: Keeps shared memory writes ordered across eligible panes. */
export async function cmdDream(ctx, flags = {}, { getStatus, getLivePanes } = {}) {
  if (typeof getStatus !== "function" || typeof getLivePanes !== "function") {
    throw new Error("dream command requires getStatus and getLivePanes");
  }
  const sinceArg = flags.since || "24h";
  const agents = listAgents(ctx.configPath);
  const workspaceDir = flags.workspace || process.env.OPENCLAW_WORKSPACE
    || join(process.env.HOME, ".openclaw", "workspace");

  const now = new Date();
  const dateKey = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const timeStr = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(now);
  const memPath = join(workspaceDir, "memory", `${dateKey}.md`);

  // Window: panes with any jsonl activity in the last `sinceArg` qualify.
  const since = parseSinceArg(sinceArg);
  const sinceMs = since instanceof Date ? since.getTime() : Date.now() - 24 * 3600 * 1000;

  // Window: panes with recent activity qualify, but only exact `idle` panes
  // are safe to touch. Dream writes a shared memory file and should never send
  // /compact or a follow-up prompt into a pane that is already working.
  let { targets, skipped } = await collectDreamTargets(ctx, agents, sinceMs,
    { getStatus, getLivePanes });

  const promptFor = (t) => [
    `[dream ${dateKey} ${timeStr}]`,
    ``,
    `Läs filen först:`,
    `  ${memPath}`,
    ``,
    `Ändra ENDAST ditt markerade block. Alla andra rader i filen ska vara byte-identiska efter din edit.`,
    `Om blocket finns: ersätt bara innehållet mellan start- och slutmarkören.`,
    `Om blocket saknas: append:a blocket längst ned i filen.`,
    ``,
    `Startmarkör: ${dreamBlockMarkers(t, dateKey).start}`,
    `Slutmarkör:  ${dreamBlockMarkers(t, dateKey).end}`,
    ``,
    `Blocket ska ha exakt denna struktur:`,
    `<!-- amux-dream-${t.agent}-${t.pane}:${dateKey} -->`,
    `## ${t.agent}:${t.pane}`,
    `- Sammanfatta vad vi jobbat med sen sist (senaste ~24h).`,
    `- Inkludera viktiga beslut, gotchas och kodändringar.`,
    `- Skanbart med bullets, max ~10 rader totalt.`,
    `<!-- /amux-dream-${t.agent}-${t.pane}:${dateKey} -->`,
    ``,
    `Kör sen detta i shellet för att uppdatera Discord-topicen:`,
    `   amux topic ${t.agent} -p ${t.pane} "[${t.agent}:${t.pane}] dreamed ${timeStr} | <din 1-rads summary>"`,
    ``,
    `När allt är klart: svara med exakt en kort rad: DREAM_OK <din 1-rads summary>.`,
  ].join("\n");

  const existingContent = existsSync(memPath) ? readFileSync(memPath, "utf-8") : "";
  const allRecent = [...targets, ...skipped];
  const reportableRecent = allRecent.filter((target) =>
    target.status !== "not-live-claude" && target.status !== "unknown");
  if (flags.retry) {
    targets = targets.filter((target) => !hasDreamPaneBlock(existingContent, target, dateKey));
  }

  const finalizeSentinel = (passOk, passFailed) => {
    if (flags.deferSentinel || flags["defer-sentinel"]) return { ok: passOk, failed: passFailed };
    const content = readFileSync(memPath, "utf-8");
    const totalOk = reportableRecent.filter((target) => hasDreamPaneBlock(content, target, dateKey)).length;
    const pending = reportableRecent.filter((target) => !hasDreamPaneBlock(content, target, dateKey)).length;
    const totalFailed = Math.max(passFailed, pending);
    writeDreamRunSentinel(memPath, dateKey, timeStr, totalOk, totalFailed);
    return { ok: totalOk, failed: totalFailed };
  };

  if (flags.dry) {
    console.log(`Dream would process ${targets.length} idle pane(s) sequentially:\n`);
    for (const t of targets) {
      console.log(`--- ${t.agent}:${t.pane} (last activity ${new Date(t.lastMs).toISOString().slice(11, 16)} UTC) ---`);
      console.log(`  send: /compact`);
      console.log(`  wait: pane idle (≤180s)`);
      console.log(`  send: dream prompt (${promptFor(t).length} chars)`);
      console.log(`  wait: pane idle (≤300s)`);
    }
    if (skipped.length) {
      console.log(`\nSkipped ${skipped.length} non-runnable pane(s):`);
      for (const t of skipped) {
        const live = t.liveCommand ? `; live=${t.liveCommand}` : "";
        console.log(`--- ${t.agent}:${t.pane} (${t.status}${live}; last activity ${new Date(t.lastMs).toISOString().slice(11, 16)} UTC) ---`);
      }
    }
    runDreamJanitor(flags); // preview the housekeeping pass too (no lock needed for dry)
    return;
  }

  const lock = acquireDreamLock();
  if (!lock.acquired) return;

  let okCount = 0;
  let failedCount = 0;

  try {
    ensureDreamDailyFile(memPath, dateKey);

    if (!targets.length) {
      if (!flags.quiet && !flags.q) {
        if (skipped.length) console.log(`Dream: no runnable claude panes with activity since ${sinceArg}; skipped ${skipped.length} non-runnable pane(s).`);
        else console.log(`Dream: no claude panes with activity since ${sinceArg}.`);
      }
      const totals = finalizeSentinel(0, 0);
      if (totals.failed > 0) process.exitCode = 1;
      return;
    }

    if (!flags.quiet && !flags.q) {
      console.log(`Dream: processing ${targets.length} pane(s) sequentially…`);
      if (skipped.length) console.log(`Dream: skipped ${skipped.length} non-runnable pane(s).`);
    }

    for (let idx = 0; idx < targets.length; idx++) {
      const t = targets[idx];
      const key = `${t.agent}:${t.pane}`;
      const tag = `[dream ${idx + 1}/${targets.length}]`;

      const preStatus = await getStatus(ctx, t.agent, t.pane).catch(() => "unknown");
      if (!isDreamRunnableStatus(preStatus)) {
        if (!flags.quiet && !flags.q) console.log(`${tag} ${key} became ${preStatus} before send \u2014 skipping`);
        continue;
      }

      if (!flags.quiet && !flags.q) console.log(`${tag} ${key} → /compact`);
      try {
        const sent = await sendToPane(ctx, t.agent, t.pane, "/compact", { mirror: false });
        if (!sent?.delivered) throw new Error(sent?.blocked ? "blocked by park-guard" : "delivery not acknowledged");
      } catch (err) {
        failedCount++;
        console.warn(`${tag} ${key} /compact failed: ${err.message}`);
        continue;
      }
      const cRes = await waitForPaneIdle(ctx, t.agent, t.pane, getStatus, 180_000, 3);
      if (!cRes.idle) {
        failedCount++;
        console.warn(`${tag} ${key} did not idle after /compact (180s; last=${cRes.status}) \u2014 skipping`);
        continue;
      }

      const prompt = promptFor(t);
      if (!flags.quiet && !flags.q) console.log(`${tag} ${key} → dream prompt`);
      try {
        // Background maintenance should not dump the full internal prompt into
        // Discord. The agent still updates the memory file and channel topic.
        const sent = await sendToPane(ctx, t.agent, t.pane, prompt, { source: "dream", mirror: false });
        if (!sent?.delivered) throw new Error(sent?.blocked ? "blocked by park-guard" : "delivery not acknowledged");
      } catch (err) {
        failedCount++;
        console.warn(`${tag} ${key} prompt failed: ${err.message}`);
        continue;
      }

      // Pane-local failures skip THIS pane and continue: an unresponsive or
      // slow pane must not starve the rest of the fleet's digests. Observed
      // cost of the old abort-on-first-failure: one 15s echo-timeout (ai:2)
      // cancelled three healthy panes' blocks in the same night (2026-07-10).
      const accepted = await ctx.agent.waitForPromptEcho(t.agent, t.pane, prompt, 15_000).catch(() => false);
      if (!accepted) {
        failedCount++;
        console.warn(`${tag} ${key} did not record dream prompt within 15s \u2014 Escape + skipping this pane`);
        await ctx.agent.sendEscape(t.agent, t.pane).catch(() => {});
        continue;
      }

      const pRes = await waitForPaneIdle(ctx, t.agent, t.pane, getStatus, 300_000, 3);
      if (!pRes.idle) {
        failedCount++;
        console.warn(`${tag} ${key} did not finish dream prompt within 5min (last=${pRes.status}) \u2014 Escape + skipping this pane`);
        await ctx.agent.sendEscape(t.agent, t.pane).catch(() => {});
        continue;
      }

      const wroteBlock = await waitForDreamPaneBlock(memPath, t, dateKey);
      if (!wroteBlock) {
        failedCount++;
        console.warn(`${tag} ${key} finished but did not write its dream marker block within 15s \u2014 skipping this pane`);
        continue;
      }

      const block = validateDreamPaneBlock(
        readFileSync(memPath, "utf-8"), t, dateKey,
        Number(process.env.AMUX_DREAM_BLOCK_MAX_LINES) || 10,
      );
      if (!block.ok) {
        console.warn(`${tag} ${key} wrote an oversized dream block: ${block.reason}`);
      }

      okCount++;
      if (!flags.quiet && !flags.q) console.log(`${tag} ${key} done`);
    }

    const totals = finalizeSentinel(okCount, failedCount);
    if (!flags.quiet && !flags.q) {
      console.log(`Dream complete: ${totals.ok} pane block(s) present, ${totals.failed} pending/failed.`);
    }

    if (totals.failed > 0) process.exitCode = 1;
  } finally {
    // Housekeeping runs under the dream lock (before release) so two racing
    // dream runs can't gzip the same file concurrently. Reached on every
    // non-dry path: normal completion, no-targets return, and aborts.
    runDreamJanitor(flags);
    lock.release();
  }
}

/**
 * Nightly session-file housekeeping, folded into `amux dream` so there's one
 * maintenance pass instead of a second cron. Deletes jsonl no agent has
 * touched in the retention window (default 14d) — dead sessions only; live
 * files have fresh mtime and are never matched. Quiet unless something
 * happened (or non-quiet). Never throws — a janitor failure must not affect
 * dream's outcome. Disable with AMUX_JANITOR_ENABLED=false.
 */
function runDreamJanitor(flags = {}) {
  if (process.env.AMUX_JANITOR_ENABLED === "false") return;
  try {
    const jr = pruneOldSessions({ dryRun: !!flags.dry });
    const verbose = !flags.quiet && !flags.q;
    if (verbose || jr.deleted || jr.failed) console.log(formatJanitorResult(jr));
  } catch (err) {
    console.warn(`janitor skipped: ${err.message}`);
  }
}
