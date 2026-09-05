// On-demand Dream health. Reads existing schedule and artifacts; never runs Dream.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { loadConfig } from "../cli/config.mjs";
import { defaultWorkspace, runtimeAgentsPath } from "./runtime-defaults.mjs";
import { localDateKey } from "./memory-policy.mjs";
import { readDreamOwnerResult } from "./dream-owner.mjs";

const result = (state, detail, extra = {}) => ({ state, status: state === "warn" ? "warn" : "ok", detail, ...extra });

/** WHAT: Parses the existing daily Dream cron entry. WHY: Prevents health checks from inventing a separate schedule. */
export function parseDreamSchedule(crontab, { timeZone, graceMs = 3_600_000 } = {}) {
  const schedules = [];
  for (const raw of String(crontab).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const tz = line.match(/^CRON_TZ\s*=\s*["']?([^"'\s]+)["']?$/);
    if (tz) { timeZone = tz[1]; continue; }
    if (!/(?:^|\/)dream-cron\.sh(?:\s|$)/.test(line)) continue;
    const match = line.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*\s+/);
    if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) throw new Error("Dream cron schedule is not a supported daily hour/minute entry");
    new Intl.DateTimeFormat("en", { timeZone }).format();
    schedules.push({ minute: Number(match[1]), hour: Number(match[2]), timeZone, graceMs });
  }
  if (schedules.length > 1) throw new Error("multiple Dream cron entries; schedule is ambiguous");
  return schedules[0] || null;
}

function partsAt(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
}

function scheduledTime(day, schedule) {
  const desired = Date.UTC(day.year, day.month - 1, day.day, schedule.hour, schedule.minute);
  let ms = desired;
  for (let i = 0; i < 4; i++) {
    const p = partsAt(new Date(ms), schedule.timeZone);
    const delta = desired - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    if (!delta) return ms;
    ms += delta;
  }
  throw new Error("Dream schedule falls in an ambiguous or nonexistent local time");
}

/** WHAT: Calculates today's Dream deadline. WHY: Keeps grace and cron timezone separate from Stockholm memory filenames. */
export function dreamDeadline(now, schedule) {
  const day = partsAt(now, schedule.timeZone);
  let startMs = scheduledTime(day, schedule);
  // A late-night run's grace can end tomorrow. Keep checking that expected
  // run after midnight instead of postponing it to the next night's deadline.
  if (now.getTime() < startMs && partsAt(new Date(startMs + schedule.graceMs), schedule.timeZone).day !== day.day) {
    const previous = new Date(Date.UTC(day.year, day.month - 1, day.day - 1));
    startMs = scheduledTime({ year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, day: previous.getUTCDate() }, schedule);
  }
  return { startMs, deadlineMs: startMs + schedule.graceMs, dateKey: localDateKey(new Date(startMs)) };
}

/** WHAT: Checks the controller's existing Dream artifacts. WHY: Prevents cron starts or stale marker text from counting as success. */
export function readDreamSuccess(workspace, dateKey, { home, now = new Date() } = {}) {
  let text;
  try { text = readFileSync(join(workspace, "memory", `${dateKey}.md`), "utf8"); }
  catch (error) { return { ok: false, reason: error.code === "ENOENT" ? "daily result missing" : `daily result unreadable: ${error.code}` }; }
  const runs = [...text.matchAll(/<!-- amux-dream-run:(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) \((\d+) panes ok \/ (\d+) failed\) -->/g)];
  const run = runs.filter((m) => m[1] === dateKey).at(-1);
  if (!run) return { ok: false, reason: "current run sentinel missing or stale" };
  if (+run[2].slice(0, 2) > 23 || +run[2].slice(3) > 59) return { ok: false, reason: "invalid run time" };
  const startMs = scheduledTime({ year: +dateKey.slice(0, 4), month: +dateKey.slice(5, 7), day: +dateKey.slice(8) },
    { timeZone: "Europe/Stockholm", hour: +run[2].slice(0, 2), minute: +run[2].slice(3) });
  if (startMs > now.getTime()) return { ok: false, reason: "run sentinel is in the future" };
  if (+run[4] > 0) return { ok: false, reason: `${run[4]} pane journals failed` };
  if (+run[3] === 0) return { ok: true, reason: "controller verified no new work", time: run[2] };
  const start = text.indexOf(`<!-- amux-dream-summary:${dateKey} -->`);
  const end = text.indexOf(`<!-- /amux-dream-summary:${dateKey} -->`, start);
  if (start < 0 || end < start) return { ok: false, reason: "committed summary block missing" };
  const block = text.slice(start, end);
  const receipt = block.match(/ · run `([0-9a-f-]{36})` · source `([0-9a-f]{64})`\./);
  if (!receipt) return { ok: false, reason: "summary run/source receipt missing" };
  try {
    const path = join(home, ".agentmux", "dream-input", `${dateKey}-${receipt[1]}`);
    const bytes = readFileSync(`${path}.json`), input = JSON.parse(bytes);
    if (createHash("sha256").update(bytes).digest("hex") !== receipt[2] || input.dateKey !== dateKey
      || !Number.isFinite(Date.parse(input.createdAt)) || Date.parse(input.createdAt) > now.getTime()) {
      return { ok: false, reason: "input identity/date mismatch" };
    }
    const product = readDreamOwnerResult(`${path}.summary.md`, dateKey, receipt[1], input.owner, receipt[2]);
    if (!product.ok || !block.includes(product.content)) return { ok: false, reason: product.reason || "committed product mismatch" };
    return { ok: true, time: run[2], runId: receipt[1], panes: +run[3] };
  } catch (error) { return { ok: false, reason: `result artifacts unreadable: ${error.code || error.message}` }; }
}

/** WHAT: Checks scheduled Dream freshness. WHY: Prevents missing runs from hiding behind an absent failure marker. */
export function assessDreamHealth({ now, schedule, success }) {
  const due = dreamDeadline(now, schedule);
  const deadline = new Date(due.deadlineMs).toISOString();
  if (success?.ok) return result("healthy", `validated ${due.dateKey} ${success.time || ""} Dream`, { ...due, success });
  if (now.getTime() < due.deadlineMs) return result("pending", `Dream not due until ${deadline} (grace ${schedule.graceMs / 60000} min)`, due);
  return result("warn", `Dream ${due.dateKey} missing/stale after ${deadline}: ${success?.reason || "no validated result"}`, due);
}

/** WHAT: Reads local Dream health evidence. WHY: Keeps offline inspection free of prompts, network calls and cron mutations. */
export function observeDreamHealth(workspace, {
  env = process.env, home = env.HOME, now = new Date(), configPath = runtimeAgentsPath(env, home),
  config,
  readCrontab = () => execFileSync("crontab", ["-l"], { encoding: "utf8", timeout: 1500, maxBuffer: 128 * 1024, stdio: ["ignore", "pipe", "pipe"] }),
} = {}) {
  try {
    config ??= loadConfig(configPath);
    const scheduledWorkspace = env.OPENCLAW_WORKSPACE || env.AMUX_WORKSPACE || defaultWorkspace(home);
    if (resolve(workspace) !== resolve(scheduledWorkspace)) return result("disabled", "this workspace is not the configured nightly Dream target");
    let crontab;
    try { crontab = readCrontab(); }
    catch (error) {
      return config.dream ? result("warn", `Dream schedule unverified: ${error.code || "crontab unavailable"}`)
        : result("disabled", "Dream is not configured; local cron unavailable");
    }
    let timeZone;
    try { timeZone = readFileSync("/etc/timezone", "utf8").trim(); }
    catch { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; }
    const graceMs = Number(env.AMUX_DREAM_GRACE_MS || 3_600_000);
    if (!Number.isInteger(graceMs) || graceMs < 60_000 || graceMs > 21_600_000) throw new Error("AMUX_DREAM_GRACE_MS must be 60000..21600000");
    const schedule = parseDreamSchedule(crontab, { timeZone, graceMs });
    if (!schedule) return config.dream ? result("warn", "Dream curator configured but nightly cron entry is missing")
      : result("disabled", "nightly Dream is not configured");
    if (!config.dream) return result("warn", "Dream cron exists but no curator is configured");
    const { dateKey } = dreamDeadline(now, schedule);
    const success = readDreamSuccess(workspace, dateKey, { home, now });
    return assessDreamHealth({ now, schedule, success });
  } catch (error) { return result("warn", `Dream health unverified: ${error.message}`); }
}
