import { isUnsubmittedQuotaJob, isUnsentQuotaFloorJob } from "./quota-floor-job.mjs";
import { createHash } from "node:crypto";
import { accountWindows, quotaFloorHold } from "./quota-park.mjs";
import { quotaObservedAt } from "./quota-wind-down.mjs";
import { compactPaneList } from "./quota-format.mjs";

/** WHAT: Defines the durable alert state key. WHY: Keeps delivery episodes separate from task state. */
export const QUOTA_FLOOR_ALERT_STATE = "quota_floor_alert_v1";
/** WHAT: Defines the delay after a proven refusal. WHY: Keeps brief quota holds from alerting the operator. */
export const QUOTA_FLOOR_ALERT_AFTER_MS = 30 * 60_000;
const FRESH_MS = 10 * 60_000;
const unsent = isUnsubmittedQuotaJob;
const floorHeld = isUnsentQuotaFloorJob;
const paneOf = job => `${job.agentName}:${job.pane}`;
const identity = account => account?.account?.email || account?.account?.identityKey;
const accountKey = account => identity(account) ? `${account.provider}:${String(identity(account)).toLowerCase()}` : null;
const hash = text => createHash("sha256").update(text).digest("hex").slice(0, 24);
const instant = at => Number.isFinite(at) ? new Date(at).toISOString() : "unknown";
const fresh = (account, now) => account?.ok && Number.isFinite(quotaObservedAt(account))
  && quotaObservedAt(account) <= now && now - quotaObservedAt(account) <= FRESH_MS;
const holdOf = (account, floorPercent, now) => quotaFloorHold({ windows: accountWindows(account),
  provider: account.provider, floorPercent, now });
const namesAccount = (reason, name) => {
  const text = String(reason || "").replace(/^wake-refused:/u, "");
  return text.startsWith(`quota-floor: ${name} has `) || text.startsWith(`quota-floor: ${name} (reading failed;`);
};

/** WHAT: Returns dated Codex capacity in both windows. WHY: Prevents absent or stale windows from being advertised as spare quota. */
export function quotaAlertCodexCapacity(accounts, now) {
  return accounts.filter(account => account.provider === "codex" && fresh(account, now)).flatMap(account => {
    const windows = accountWindows(account);
    const both = ["session", "week"].map(kind => windows.find(window => window.kind === kind));
    if (!both.every(window => window && window.usedPercent >= 0 && window.usedPercent < 100
      && Date.parse(window.resetsAt) > now)) return [];
    return [{ name: account.name || "Codex", sessionLeft: 100 - both[0].usedPercent,
      weekLeft: 100 - both[1].usedPercent, observedAt: instant(quotaObservedAt(account)) }];
  });
}

/** WHAT: Returns proven unsent floor holds by stable account. WHY: Keeps retry counts and other accounts out of the waiting-job total. */
export function quotaFloorGroups({ snapshot, jobs, refusals, compactions = {}, now }) {
  const accounts = snapshot?.accounts || [];
  const assigned = new Map(accounts.flatMap(account => (account.inUse || []).map(pane => [pane, accountKey(account)])));
  const named = reason => accounts.find(account => account.name && namesAccount(reason, account.name)
    && accounts.filter(other => other.name === account.name).length === 1);
  const deniedAccount = job => {
    const current = named(job.lastReason);
    if (current) return accountKey(current);
    const prior = refusals.filter(row => row.jobId === job.id && row.at <= now && named(row.reason)).sort((a, b) => b.at - a.at)[0];
    return prior ? accountKey(named(prior.reason)) : null;
  };
  return accounts.flatMap(account => {
    const key = accountKey(account);
    if (!key) return [];
    const panes = new Set(account.inUse || []);
    const held = jobs.filter(job => {
      if (!floorHeld(job)) return false;
      const denied = deniedAccount(job);
      return assigned.has(paneOf(job)) ? panes.has(paneOf(job)) && (!denied || denied === key) : denied === key;
    });
    if (!held.length) return [];
    const heldPanes = new Set(held.map(paneOf));
    const evidence = held.map(job => {
      const rows = refusals.filter(row => row.jobId === job.id && Number.isFinite(row.at) && row.at <= now
        && (!row.reason || !named(row.reason) || namesAccount(row.reason, account.name)));
      return { jobId: job.id, at: rows.length ? Math.min(...rows.map(row => row.at)) : now,
        lastAt: rows.length ? Math.max(...rows.map(row => row.at)) : now,
        source: rows.length ? `events.jsonl:${job.id}` : `queue:${job.id}:first-observed-hold` };
    });
    return [{ key, account, evidence, panes: [...heldPanes].sort(),
      jobs: [...new Set(jobs.filter(job => heldPanes.has(paneOf(job)) && unsent(job)).map(job => job.id))],
      compactions: [...heldPanes].flatMap(pane => compactions[pane]?.cause?.includes("delivery-pending")
        && (!Number.isFinite(compactions[pane].observedAt) || compactions[pane].observedAt >= Math.min(...evidence.map(item => item.at)))
        ? [{ pane, ...compactions[pane] }] : []) }];
  });
}

/** WHAT: Formats one account's delayed-delivery notice. WHY: Keeps unknown timing explicit and compaction waits within the same notice. */
export function formatQuotaFloorAlert(episode, accounts, now) {
  const capacity = quotaAlertCodexCapacity(accounts, now);
  const room = capacity.length ? capacity.map(item => `${item.name}: 5h ${item.sessionLeft}% kvar, vecka ${item.weekLeft}% kvar, avläst ${item.observedAt}`).join("; ") : "unknown (ingen verifierad kapacitet i båda fönstren)";
  const compactions = episode.compactions.slice(0, 2).map(item => {
    const age = Number.isFinite(item.lastActivityMs) ? `${Math.max(0, Math.floor((now - item.lastActivityMs) / 60_000))} min` : "unknown";
    return `${item.pane}: belagd compaction waiting for quota-held delivery; källa ${item.source || `compact-held-notices/${item.pane}`}, tid ${instant(item.observedAt)}, cacheålder ${age}, cacheutgång ${instant(item.cacheExpiresAt)}${item.cacheTimePrecision === "minute" ? " (minutprecision)" : ""}`;
  }).join(". ");
  const attempts = Object.entries(episode.warmCompactions || {}).map(([pane, record]) => {
    const last = record.attempts.at(-1);
    return `${pane}: varm kompaktering ${record.attempts.length}/2 försök, utfall ${last?.status || "unknown"}${record.attempts.length >= 2 ? ", försöksgränsen nådd för denna episod" : ""}`;
  }).join("; ");
  return `${episode.name} har spärrat leveranser i minst ${Math.floor((now - episode.firstRefusedAt) / 60_000)} min. `
    + `${episode.jobs.length} jobb väntar i ${episode.panes.length} panel${episode.panes.length === 1 ? "" : "er"}: ${compactPaneList(episode.panes)}. `
    + `Återställning ${episode.resetAt || "unknown"} (datum med tidszon), avläst ${episode.observedAt || "unknown"}. `
    + `Första belagda nekande ${instant(episode.firstRefusedAt)}, källa ${episode.source}. `
    + `Codex-kapacitet: ${room}. ${compactions ? `${compactions}. ` : ""}${attempts ? `${attempts}. ` : ""}`
    + (episode.compactions.length > 2 ? `Även kompakteringsväntan i ${compactPaneList(episode.compactions.slice(2).map(item => item.pane))}; fulla källor sparade i episod ${episode.id}. ` : "")
    + "Förslag: dispatchern väljer ett redan beställt arbete som kan utföras där. Aviseringen flyttar eller skickar inte om någon leverans.";
}

/** WHAT: Builds durable per-account notices with independent recipient receipts. WHY: Prevents restarts and unknown sends from replaying an alert or a delivery. */
export function createQuotaFloorAlert({ state, readEvidence, notifyHuman, notifyDispatcher,
  lookupDispatcher = () => null, floorPercent = 3, now = Date.now, log = () => {} }) {
  if (!state?.updateKey) throw Error("quota-floor alert requires atomic state.updateKey");
  const change = fn => state.updateKey(QUOTA_FLOOR_ALERT_STATE, old => {
    const data = old || { version: 1, accounts: {} };
    fn(data); return data;
  });
  const get = key => state.get(QUOTA_FLOOR_ALERT_STATE)?.accounts[key];
  let running = null;

  async function reconcile(key, archived = false) {
    const read = () => archived ? state.get(QUOTA_FLOOR_ALERT_STATE).history[key] : get(key);
    const record = data => archived ? data.history[key] : data.accounts[key];
    const receipt = read().receipts.dispatcher;
    if (receipt && ["attempting", "unknown", "queued"].includes(receipt.status)) {
      const job = await lookupDispatcher(`quota-floor:${read().id}:dispatcher`, receipt);
      const status = job?.status === "acknowledged" ? "delivered"
        : ["cancelled", "dead_letter"].includes(job?.status) ? "not-delivered" : job ? "queued" : "unknown";
      change(data => { record(data).receipts.dispatcher = { ...receipt, status,
        ...(job ? { jobId: job.id, transportStatus: job.status, acknowledgedAt: job.acknowledgedAt || null } : {}) }; });
    }
    if (read().receipts.human?.status === "attempting") {
      change(data => { record(data).receipts.human.status = "unknown"; });
    }
  }

  async function recipient(key, kind, send, accounts) {
    let episode = get(key), receipt = episode.receipts[kind];
    const idempotencyKey = `quota-floor:${episode.id}:${kind}`;
    episode = get(key); receipt = episode.receipts[kind];
    if (receipt && !["not-sent"].includes(receipt.status)) return;
    let claimed = false;
    change(data => {
      const current = data.accounts[key].receipts[kind];
      if (!current || current.status === "not-sent") {
        data.accounts[key].receipts[kind] = { status: "attempting", at: now(), idempotencyKey }; claimed = true;
      }
    });
    if (!claimed) return;
    let result;
    try { result = await send(formatQuotaFloorAlert(get(key), accounts, now()), idempotencyKey); }
    catch (error) { result = { outcome: error.notSent === true ? "not-sent" : "unknown", reason: error.message }; }
    const status = result?.sent === true || result?.deduped === true ? "delivered"
      : result?.jobId ? "queued" : result?.outcome === "not-sent" ? "not-sent" : "unknown";
    change(data => { data.accounts[key].receipts[kind] = { ...data.accounts[key].receipts[kind], status,
      completedAt: now(), ...(result?.jobId ? { jobId: result.jobId } : {}),
      ...(result?.messageId ? { messageId: result.messageId, channelId: result.channelId } : {}),
      ...(result?.reason ? { reason: String(result.reason).slice(0, 200) } : {}) }; });
    log(`${get(key).name}: ${kind} ${status}, episode ${get(key).id}`);
  }

  async function run() {
    const evidence = await readEvidence();
    const at = now(), accounts = evidence.snapshot?.accounts || [];
    const groups = quotaFloorGroups({ ...evidence, now: at });
    change(data => {
      for (const [key, previous] of Object.entries(data.accounts)) {
        const account = accounts.find(item => accountKey(item) === key);
        const observed = quotaObservedAt(account);
        if (account && fresh(account, at) && observed >= previous.lastRefusedAt
          && (!previous.resetAt || Date.parse(previous.resetAt) > at || observed > Date.parse(previous.resetAt))
          && !holdOf(account, floorPercent, at)) {
          previous.status = "recovered"; previous.recoveredAt ??= at;
        }
      }
      for (const group of groups) {
        const previous = data.accounts[group.key];
        const observed = quotaObservedAt(group.account);
        if (fresh(group.account, at) && observed >= Math.max(...group.evidence.map(item => item.lastAt))
          && !holdOf(group.account, floorPercent, at)) continue;
        const proofs = group.evidence.flatMap(item => {
          if (!previous?.recoveredAt) return [item];
          const after = evidence.refusals.filter(row => row.jobId === item.jobId && row.at > previous.recoveredAt && row.at <= at);
          return after.length ? [{ ...item, at: Math.min(...after.map(row => row.at)), lastAt: Math.max(...after.map(row => row.at)) }]
            : item.source.includes("first-observed") && item.at > previous.recoveredAt ? [item] : [];
        });
        if (!proofs.length) continue;
        const proof = proofs.reduce((a, b) => a.at < b.at ? a : b);
        const first = previous?.status !== "recovered" ? previous : null;
        if (previous && !first) { data.history ??= {}; data.history[previous.id] = previous; }
        const started = first?.firstRefusedAt ?? Math.max(proof.at, previous?.recoveredAt || 0);
        const hold = fresh(group.account, at) ? holdOf(group.account, floorPercent, at) : null;
        data.accounts[group.key] = { ...first, id: first?.id || hash(`${group.key}:${started}:${at}`),
          name: group.account.name || group.account.provider, status: "held", firstRefusedAt: started,
          lastRefusedAt: Math.max(...proofs.map(item => item.lastAt)), source: first?.source || proof.source,
          resetAt: hold?.resetsAt || null, observedAt: fresh(group.account, at) ? instant(observed) : null,
          jobs: group.jobs, panes: group.panes, compactions: group.compactions, receipts: first?.receipts || {} };
      }
      data.lastCheckedAt = at;
    });
    const result = [];
    for (const id of Object.keys(state.get(QUOTA_FLOOR_ALERT_STATE).history || {})) await reconcile(id, true);
    for (const [key, episode] of Object.entries(state.get(QUOTA_FLOOR_ALERT_STATE).accounts)) {
      await reconcile(key);
      if (episode.status !== "held" || at - episode.firstRefusedAt <= QUOTA_FLOOR_ALERT_AFTER_MS) continue;
      // No waiting work means no new send; retain the episode until recovery is proven.
      if (!groups.some(group => group.key === key)) continue;
      await recipient(key, "human", notifyHuman, accounts);
      await recipient(key, "dispatcher", notifyDispatcher, accounts);
      result.push({ id: episode.id, name: episode.name, receipts: get(key).receipts });
    }
    return result;
  }
  return { tick: () => (running ||= run().finally(() => { running = null; })) };
}
