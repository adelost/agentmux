// One sequential maintenance pass. Never starts engines or sends prose to them.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { listAgents, loadConfig, findChannelForPane } from "./config.mjs";
import { listPanes } from "./tmux.mjs";
import { dialectFor, inspectPane } from "./inspect-pane.mjs";
import { sendToChannelId } from "./send-notify.mjs";
import { panePathFor } from "../core/jsonl-reader.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { latestConversationActivityMs } from "../core/pane-activity.mjs";
import { readDreamOwnerQuality } from "../core/dream-owner.mjs";
import { codexComposerText } from "../core/codex-tui.mjs";
import { findBlockingPrompt } from "../core/dismiss.mjs";
import { createDeliveryQueue, TERMINAL_DELIVERY_STATES } from "../core/delivery-queue.mjs";
import { verifiedClaudeCompact, verifiedCodexCompact } from "../core/verified-compact.mjs";
import { compactAccessBlocker, nightlyCompactDecision, nightlyCompactOutcome, nightlyCompactPolicy } from "../core/nightly-compact.mjs";

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const dayKey = (now) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date(now));

function readReport(path, dateKey) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value.version !== 1 || value.dateKey !== dateKey || !value.panes || typeof value.panes !== "object" || Array.isArray(value.panes)) {
      throw new Error("invalid nightly compact receipt state");
    }
    return value;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version: 1, dateKey, panes: {} };
  }
}

function writeReport(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function composerText(screen, engine) {
  if (findBlockingPrompt(screen)) return null;
  if (engine === "codex") return codexComposerText(screen);
  const lines = String(screen).split("\n");
  const at = lines.findLastIndex((line) => /^\s*❯/u.test(line));
  const separator = lines.findIndex((line, index) => index > at && /^\s*[─━]{3}/u.test(line));
  return at >= 0 && separator > at
    ? [lines[at].replace(/^\s*❯\s*/u, ""), ...lines.slice(at + 1, separator)].join("\n").trim() : null;
}

/** WHAT: Reads the live pane without waking it. WHY: Keeps maintenance bound to exact idle sessions and empty composers. */
export async function observeNightlyPane(ctx, target, { queue, now = Date.now } = {}) {
  const { agent, pane, engine, paneDir } = target;
  const before = latestPaneSessionIdentity(engine, paneDir);
  const process = await ctx.agent.paneProcessState(agent.name, pane.index).catch(() => null);
  const screen = await ctx.agent.captureScreen(agent.name, pane.index).catch(() => "");
  const observed = await inspectPane(ctx, agent, { ...pane, command: process?.command, dead: process?.dead });
  const quality = await readDreamOwnerQuality({ agent: agent.name, pane: pane.index, engine, paneDir }, {
    captureScreen: async () => screen,
  });
  const after = latestPaneSessionIdentity(engine, paneDir);
  const stable = before?.sessionId && before.sessionId === after?.sessionId && before.path === after?.path;
  const activity = latestConversationActivityMs(paneDir, engine);
  let queued = null;
  try { queued = queue.list(agent.name, pane.index).filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status)).length; }
  catch { /* unknown queue state never authorizes a compact */ }
  return {
    engine, backend: agent.backend, running: process?.running === true && !process.dead && !process.shell
      && (engine === "claude" ? process.command === "claude" : ["node", "codex"].includes(process.command)),
    sessionId: stable ? after.sessionId : null, sessionPath: stable ? after.path : null,
    status: observed.status, composerEmpty: composerText(screen, engine) === "", queued,
    tokens: observed.context?.tokens ?? null,
    model: quality?.sessionId === after?.sessionId ? quality.model : null,
    effort: quality?.sessionId === after?.sessionId ? quality.effort : null,
    idleMs: Number.isFinite(activity) ? now() - activity : null, activity,
    blocker: compactAccessBlocker(screen),
  };
}

async function discover(ctx, agents) {
  const targets = [];
  for (const agent of agents) {
    if (agent.backend !== "tmux") {
      for (let index = 0; index < agent.panes.length; index++) targets.push({ agent, pane: { index }, engine: "native" });
      continue;
    }
    const panes = await listPanes(ctx, agent.name).catch(() => []);
    for (const pane of panes) {
      const engine = dialectFor(agent, pane);
      if (!engine) continue;
      targets.push({ agent, pane, engine, paneDir: panePathFor(agent, pane.index) });
    }
  }
  return targets;
}

async function mirror(ctx, target, command) {
  const channel = findChannelForPane(ctx.configPath, target.agent.name, target.pane.index);
  if (!channel) return;
  const receipts = await sendToChannelId(channel, `[nightly compact] ${command}`);
  if (!receipts?.length) throw new Error("compact-mirror-unverified");
}

/** WHAT: Routes one idle context pass per night. WHY: Keeps the 80k budget independent of Dream activity and the 60-percent daytime trigger. */
export async function runNightlyCompact(ctx, flags = {}, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const dateKey = dayKey(now());
  const policy = nightlyCompactPolicy((dependencies.runtimeConfig || loadConfig(ctx.configPath))?.dream?.compact);
  if (!policy.enabled) return { disabled: true, rows: [] };
  let targets = dependencies.targets || await discover(ctx, dependencies.agents || listAgents(ctx.configPath));
  if (dependencies.onlyTarget) targets = targets.filter((target) => target.agent.name === dependencies.onlyTarget.agent && target.pane.index === dependencies.onlyTarget.pane);
  if (dependencies.onlyTarget && !targets.length) throw new Error("No running configured coding pane matches the nightly target");
  const path = dependencies.path || join(homedir(), ".agentmux", "nightly-compact", dateKey);
  const observe = dependencies.observe || observeNightlyPane;
  const sleep = dependencies.sleep || pause;
  const queue = dependencies.queue || createDeliveryQueue({ initialize: !flags.dry });
  const rows = [];
  console.log(`Nightly compact: >${policy.maxTokens} tokens, idle >=${policy.idleMinutes}min, at most one attempt/session/night${flags.dry ? " (dry)" : ""}.`);
  for (const target of targets) {
    const key = `${target.agent.name}:${target.pane.index}`;
    const receiptPath = join(path, `${encodeURIComponent(key)}.json`);
    if (!["claude", "codex"].includes(target.engine)) {
      rows.push({ pane: key, status: "skipped", reason: "compact-receipt-unsupported" });
      continue;
    }
    let first;
    try { first = await observe(ctx, target, { queue, now }); }
    catch { rows.push({ pane: key, status: "skipped", reason: "observation-unavailable" }); continue; }
    const previous = readReport(receiptPath, dateKey).panes[key];
    const reason = nightlyCompactDecision(first, policy, previous);
    if (reason) { rows.push({ pane: key, status: "skipped", reason, beforeTokens: first.tokens }); continue; }
    if (flags.dry) { rows.push({ pane: key, status: "eligible", beforeTokens: first.tokens }); continue; }

    // Same cross-process lease as the broker. Enqueue remains possible; the
    // final observation sees it, or delivery waits until compact releases.
    const lease = queue.acquireSessionLease(target.agent.name);
    if (!lease) { rows.push({ pane: key, status: "skipped", reason: "delivery-lease-busy" }); continue; }
    let intent;
    const save = (row) => {
      const report = readReport(receiptPath, dateKey);
      report.policy = policy;
      report.panes[key] = row;
      writeReport(receiptPath, report);
    };
    try {
      const current = readReport(receiptPath, dateKey).panes[key];
      await sleep(200);
      const check = async () => {
        const fresh = await observe(ctx, target, { queue, now });
        const why = nightlyCompactDecision(fresh, policy, current);
        if (why || fresh.sessionId !== first.sessionId || fresh.sessionPath !== first.sessionPath
            || fresh.activity !== first.activity) throw new Error(why || "session-or-activity-changed");
        return fresh;
      };
      first = await check();
      const focus = target.engine === "claude"
        ? ` Keep under ${policy.maxTokens} tokens; preserve decisions, unfinished task and source paths. Retrieve details with amux search.` : "";
      const command = `/compact${focus}`;
      // Durable intent precedes typing. A crash/ambiguous outcome is not a
      // licence to repeat a model call on a later invocation tonight.
      intent = { sessionId: first.sessionId, sessionPath: first.sessionPath, beforeTokens: first.tokens,
        status: "attempting", attemptedAt: new Date(now()).toISOString(), command };
      save(intent);
      await (dependencies.mirror || mirror)(ctx, target, command);
      const guardedAgent = { ...ctx.agent,
        dismissBlockingPrompt: async () => {},
        sendOnly: async (name, text, pane, options) => {
          await check();
          return ctx.agent.sendOnly(name, text, pane, { ...options, existingOnly: true,
            maintenanceGuard: async (stage) => {
              if (stage === "paste") return check();
              const current = latestPaneSessionIdentity(target.engine, target.paneDir);
              const screen = await ctx.agent.captureScreen(name, pane);
              const draft = composerText(screen, target.engine);
              if (current?.sessionId !== first.sessionId || current?.path !== first.sessionPath
                  || draft == null || draft.replace(/\s/gu, "") !== text.replace(/\s/gu, "")
                  || await ctx.agent.isBusy(name, pane)
                  || queue.list(name, pane).some((job) => !TERMINAL_DELIVERY_STATES.has(job.status))) {
                throw new Error("compact-pre-submit-state-changed");
              }
            },
          });
        },
      };
      const compact = dependencies.compact || (target.engine === "claude" ? verifiedClaudeCompact : verifiedCodexCompact);
      const receipt = await compact({ agent: guardedAgent, agentName: target.agent.name, pane: target.pane.index,
        paneDir: target.paneDir, latestIdentity: (dir) => latestPaneSessionIdentity(target.engine, dir),
        command, sleep, maxRescues: 0 });
      await sleep(500);
      const after = await observe(ctx, target, { queue, now });
      const outcome = nightlyCompactOutcome(receipt, first, after, policy.maxTokens);
      const row = { ...intent, ...outcome, finishedAt: new Date(now()).toISOString() };
      save(row);
      rows.push({ pane: key, ...row });
    } catch (error) {
      const row = { ...intent, status: intent ? "failed" : "skipped", reason: error.message };
      if (intent) save(row);
      rows.push({ pane: key, ...row });
    } finally { lease.release(); }
  }
  for (const row of rows) {
    if (row.status !== "skipped" || (row.beforeTokens > policy.maxTokens)) {
      console.log(`  ${row.pane} ${row.status} ${row.beforeTokens ?? "?"} -> ${row.afterTokens ?? "?"} tokens${row.reason ? ` (${row.reason})` : ""}`);
    }
  }
  const reportPath = join(path, "runs", `${randomUUID()}.json`);
  const unresolved = rows.filter((row) => row.status === "failed" || row.status.startsWith("compacted-")
    || (row.beforeTokens > policy.maxTokens && /^(claude-subscription-access-disabled|provider-usage-limited|activity-unknown|already-attempted:(failed|attempting|compacted-))/u.test(row.reason || ""))).length;
  if (!flags.dry && targets.length) writeReport(reportPath, { dateKey, policy, rows, unresolved, observedAt: new Date(now()).toISOString() });
  console.log(`Nightly compact: ${flags.dry ? `${rows.filter((row) => row.status === "eligible").length} eligible` : `${rows.filter((row) => row.status === "within-budget").length} verified within budget`}; ${unresolved} unresolved; ${rows.filter((row) => row.status === "skipped").length} skipped. ${flags.dry ? "No receipt written" : `Report ${reportPath}`}`);
  return { policy, rows, unresolved, path: reportPath, dryRun: !!flags.dry };
}
