// A pane's queue whose head stands still is told to a pane that can act, never to the stalled pane itself (sandman:0 for Mattias,
// 12 Nov 2026: sandman:0's inbox stood still 07:58-09:36Z behind its own collapsed paste, and deep:0's alarm queued behind the same head).
// Who watches whom is agentmux.yaml's `queue_stall_watch`: `default` and per pane, e.g. { default: "sandman:0", "sandman:0": "deep:0" }.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { resolveConfigSources } from "./config-sources.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";

const HEAD_STALL_MS = 10 * 60_000;
const AGAIN_MS = 60 * 60_000;

/** WHAT: The pane that watches `target` ("agent:pane"), or null. WHY: Each stall goes to someone who can act, read fresh so an edit applies at once. */
export function stallWatcherOf(target, { read = readWatchConfig } = {}) {
  return stallWatchersOf(target, { read })[0] ?? null;
}

/** WHAT: Reads configured watchers in order. WHY: Keeps unavailable watchers from masking their reserve. */
export function stallWatchersOf(target, { read = readWatchConfig } = {}) {
  const watch = read();
  const configured = watch?.[target] ?? watch?.default ?? [];
  return (Array.isArray(configured) ? configured : [configured]).flatMap((entry) => {
    const to = String(entry).trim();
    const [session, pane, ...rest] = to.split(":");
    if (!session || !/^\d+$/u.test(pane ?? "") || rest.length || to === target) return [];
    return [{ session, pane: Number(pane), key: to }];
  });
}

function isStalled(head, now) {
  return Boolean(head && (["pasting", "drafted"].includes(head.status) || head.metadata?.preSubmitPark
    || (head.attempts > 0 && head.lastReason)) && now - Number(head.createdAt || now) >= HEAD_STALL_MS);
}

/** WHAT: Reports a stalled queue head to an available watcher. WHY: Keeps a blocked watcher from hiding the stall. */
export async function reportStalledHead({ agentName, pane, queue, now, log, watcherOf = stallWatchersOf, notify = null }) {
  const open = queue.list(agentName, pane).filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status));
  const head = open[0];
  // a head that stands still before its submit: a paste in the composer, a parked or a refused attempt; a submitted turn the pane is busy with is work
  if (!isStalled(head, now())) return null;
  const waitedMs = now() - Number(head.createdAt || now());
  const told = Number(head.metadata?.headStallNoticeAt || 0);
  const target = `${agentName}:${pane}`;
  const candidates = watcherOf(target);
  const watchers = Array.isArray(candidates) ? candidates : candidates ? [candidates] : [];
  const watcher = watchers.find((candidate) => {
    const theirHead = queue.list(candidate.session, candidate.pane).find((job) => !TERMINAL_DELIVERY_STATES.has(job.status));
    return !isStalled(theirHead, now());
  });
  const minutes = Math.round(waitedMs / 60_000);
  const text = `[AMUX köstopp] ${target}: ${open.length} meddelanden väntar, huvudet ${head.id.slice(0, 8)} har stått ${minutes} min som `
    + `${head.status} (${String(head.lastReason || "ingen orsak").slice(0, 160)}). Läs panelen (amux log ${agentName} -p ${pane} --tmux) och kön `
    + `(amux queue); ett eget utkast i rutan skickas med amux enter, annars väck panelen eller säg till dess ägare. Skicka inget om.`;
  if (notify && (!watcher || (told && now() - told >= 20 * 60_000)) && !head.metadata?.headStallHumanNoticeAt) {
    const result = await notify(text, { idempotencyKey: `queue-stall-human:${target}:${head.id}`, strictSingleAttempt: true });
    if (result.sent || result.deduped || result.outcome === "unknown") queue.update(head, { metadata: { headStallHumanNoticeAt: now() } });
  }
  if (!watcher || (told && now() - told < AGAIN_MS)) return null;
  const notice = queue.enqueue({ agentName: watcher.session, pane: watcher.pane, source: "delivery-recovery", text,
    idempotencyKey: `queue-stall:${target}:${head.id}:${Math.floor(now() / AGAIN_MS)}` });
  queue.update(head, { metadata: { headStallNoticeAt: now(), headStallNoticeTo: watcher.key } });
  log(`queue stall ${target} ${head.id}: ${minutes} min, told ${watcher.key} (${notice.id})`);
  return notice;
}

function readWatchConfig() {
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  try { return yaml.load(readFileSync(resolveConfigSources({ packageDir }).agentmuxYaml.path, "utf8"))?.queue_stall_watch ?? null; }
  catch { return null; }
}
