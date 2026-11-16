import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { appendEvent } from "./events.mjs";
import { isOwnerChannelJob } from "./ask-origin.mjs";
import { assertDeliveryPreparation } from "./delivery-preparation.mjs";

const defaultPath = join(homedir(), ".local/state/fleet-orch/cap");
const auto = job => job?.kind === "prompt" && !isOwnerChannelJob(job)
  && !(job.source === "cli" && !job.metadata?.sender) && !job.metadata?.capAnyway;
const keyOf = job => `${job.agentName}:${job.pane}`;
const eligible = job => auto(job) && ["pending", "delivering"].includes(job.status) && !job.draftOwned && !job.submittedAt
  && !job.submitFenceAt && !job.cancelRequestStatus;
async function bounded(work) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("builder cap reading timed out")), 15_000);
  })]); } finally { clearTimeout(timer); }
}

/** WHAT: Checks the per-account builder cap for a durable delivery. WHY: Keeps automatic idle starts in the existing queue. */
export function createBuilderCap({ readCap = () => readFileSync(defaultPath, "utf8"), factsFor, fallbackFacts = async () => null, isBusy, jobs,
  now = Date.now, log = error => appendEvent({ ts: new Date().toISOString(), event: "delivery_builder_cap_fault", reason: error }) } = {}) {
  let fault = false, serial = Promise.resolve();
  const reservations = new Map();
  const faultOnce = reason => { if (!fault) { fault = true; try { log(reason); } catch { /* no cap on a logging fault */ } } };
  async function check(job) {
    assertDeliveryPreparation();
    let raw;
    try { raw = readCap(); }
    catch (error) {
      if (error.code !== "ENOENT") faultOnce(error.code || "unreadable");
      return null;
    }
    const value = String(raw).trim(), cap = Number(value);
    if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(cap)) {
      faultOnce("invalid cap");
      return null;
    }
    fault = false;
    if (!eligible(job)) return null;
    let facts;
    try { facts = await bounded(async () => await factsFor(keyOf(job), { fresh: true }) || await fallbackFacts(job)); }
    catch { return "quota-floor: builder-cap: account unavailable; queued until it can be identified"; }
    assertDeliveryPreparation();
    if (facts?.unknownCapTarget) return "quota-floor: builder-cap: account unavailable; queued until it can be identified";
    if (facts?.account?.provider !== "codex") return null;
    const account = facts.accounts?.find(a => a.inUse?.includes(keyOf(job)));
    if (!account || !Array.isArray(account.inUse)) return "quota-floor: builder-cap: account unavailable; queued until it can be identified";
    const accountId = account.profile?.key || account.name || facts.account.key;
    const panes = new Set(account.inUse);
    let status;
    try { status = new Map(await bounded(() => Promise.all([...panes].map(async key => {
      if (facts.dormantTargets?.includes(key)) return [key, false];
      const split = key.lastIndexOf(":");
      return [key, await isBusy(key.slice(0, split), Number(key.slice(split + 1)))];
    })))); } catch { return "quota-floor: builder-cap: process state unavailable; queued until it can be read"; }
    assertDeliveryPreparation();
    if (status.get(keyOf(job)) === true) return null;
    const current = jobs(), byId = new Map(current.map(item => [item.id, item]));
    for (const [id, res] of reservations) {
      const entry = byId.get(id);
      if (status.get(res.pane) === true || ["cancelled", "delivered_unverified"].includes(entry?.status)
        || (entry?.status === "pending" && Number(entry.nextAttemptAt) > now() && Number(entry.lastAttemptAt) >= res.at)
        || ((!entry || entry.status === "acknowledged") && now() - res.at > 10_000)) reservations.delete(id);
    }
    if (reservations.has(job.id) && reservations.get(job.id).account === accountId) return null;
    reservations.delete(job.id);
    const busy = [...status.values()].filter(value => value !== false).length;
    // On bridge restart, in-flight jobs are durable reservations even before the target journal shows its turn.
    const occupiedPanes = new Set(current.filter(item => item.id !== job.id && panes.has(keyOf(item)) && status.get(keyOf(item)) !== true
      && ["delivering", "pasting", "drafted", "submitting", "submitted"].includes(item.status)).map(keyOf));
    for (const res of reservations.values()) if (panes.has(res.pane) && status.get(res.pane) !== true) occupiedPanes.add(res.pane);
    const occupied = occupiedPanes.size;
    const heads = new Map();
    for (const item of current) if (!["acknowledged", "cancelled", "delivered_unverified"].includes(item.status)
      && !heads.has(keyOf(item))) heads.set(keyOf(item), item.id);
    const waiting = current.filter(candidate => heads.get(keyOf(candidate)) === candidate.id && eligible(candidate) && panes.has(keyOf(candidate))
      && status.get(keyOf(candidate)) === false && !reservations.has(candidate.id)
      && (candidate.id === job.id || !String(candidate.lastReason || "").startsWith("wake-refused:quota-floor:")
        || String(candidate.lastReason).startsWith("wake-refused:quota-floor: builder-cap:")))
      .sort((a, b) => (Number(a.createdAt || 0) - Number(b.createdAt || 0)) || String(a.orderKey).localeCompare(String(b.orderKey)));
    const rank = waiting.findIndex(candidate => candidate.id === job.id);
    if (rank < 0 || busy + occupied + rank >= cap) return `quota-floor: builder-cap: ${account.name || "Codex account"} has ${busy + occupied} in turn (cap ${cap}); queued oldest first`;
    reservations.set(job.id, { pane: keyOf(job), account: accountId, at: now() });
    return null;
  }
  return job => {
    const result = serial.then(() => check(job));
    serial = result.catch(() => {});
    return result;
  };
}
