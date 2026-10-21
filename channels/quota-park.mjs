// Bridge side of parking a pane before its account stops it: the account windows
// of the pane, from the quota snapshot with the panes running on each account.

import { readLivePaneHomes, readQuotaSnapshotWithPanes, withPanesInUse } from "../core/quota-in-use.mjs";
import { quotaAccountCatalog } from "../core/quota-profiles.mjs";
import { accountWindows, STALE_READING_POLICY } from "../core/quota-park.mjs";
import { quotaObservedAt } from "../core/quota-wind-down.mjs";

const quotaProfiles = () => quotaAccountCatalog().filter((profile) => profile.provider !== "kimi");
const accountKey = (account) => account.profile?.key || account.name;

/**
 * WHAT: Returns one pane's account facts from a snapshot and each account's last good reading.
 * WHY: Keeps how a failed or partial reading reads apart from when the snapshot is read.
 */
export function paneQuotaFacts({ snapshot, lastGood = new Map(), paneKey, now }) {
  if (!snapshot) return { unavailable: true };
  // Only the pane listing sets inUse: without it, a pane at the floor would read as a pane on no account.
  if (snapshot.accounts?.length && !snapshot.accounts.some((candidate) => Array.isArray(candidate.inUse))) return { unavailable: true };
  const listed = snapshot.accounts?.find((candidate) => candidate.inUse?.includes(paneKey));
  if (!listed) return null;
  const good = listed.ok ? null : lastGood.get(accountKey(listed));
  const stale = Boolean(good) && now - quotaObservedAt(good) <= STALE_READING_POLICY.maxAgeMs;
  const account = stale ? good : listed;
  return { account: { name: account.name || account.profile?.key || null, key: account.profile?.key || null,
    provider: account.provider || null,
    ...(account.account?.email ? { email: account.account.email } : {}) }, windows: accountWindows(account),
  observedAt: quotaObservedAt(account), accounts: snapshot.accounts,
  ...(stale ? { stale: true } : account.ok ? {} : { unavailable: true }) };
}

/**
 * WHAT: Returns a reader of one pane's account and windows from a snapshot under five minutes old.
 * WHY: Keeps the minute poll from reading quota and pane homes for every pane.
 */
export function createQuotaParkFacts({
  read = () => readQuotaSnapshotWithPanes({ profiles: quotaProfiles() }),
  readPanes = () => readLivePaneHomes(),
  profiles = quotaProfiles,
  now = Date.now,
  maxAgeMs = 5 * 60_000,
  log = (message) => console.log(`quota-park | ${message}`),
} = {}) {
  let snapshot = null, readAt = -Infinity, reading = null;
  // The last good reading of each account, which a failed one stands on for a while (STALE_READING_POLICY).
  const lastGood = new Map();
  function fresh() {
    if (now() - readAt < maxAgeMs) return Promise.resolve(snapshot);
    reading ||= read().then((next) => {
      snapshot = next;
      for (const account of next?.accounts || []) if (account.ok) lastGood.set(accountKey(account), account);
      return next;
    })
      .catch((error) => { log(`snapshot read failed: ${error.message}`); return snapshot; })
      .finally(() => { readAt = now(); reading = null; });
    return reading;
  }
  // `fresh: true` keeps the cached readings but re-reads which account each pane runs on, so a pane quota
  // recovery just moved is judged by its new account (lsrc:0, 2026-10-19).
  return async (paneKey, { fresh: freshPanes = false } = {}) => {
    let current = await fresh();
    if (freshPanes && current) current = withPanesInUse(current, await readPanes(), profiles());
    return paneQuotaFacts({ snapshot: current, lastGood, paneKey, now: now() });
  };
}
