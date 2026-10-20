// Bridge side of parking a pane before its account stops it: the account windows
// of the pane, from the quota snapshot with the panes running on each account.

import { readLivePaneHomes, readQuotaSnapshotWithPanes, withPanesInUse } from "../core/quota-in-use.mjs";
import { quotaAccountCatalog } from "../core/quota-profiles.mjs";
import { accountWindows } from "../core/quota-park.mjs";

const quotaProfiles = () => quotaAccountCatalog().filter((profile) => profile.provider !== "kimi");

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
  function fresh() {
    if (now() - readAt < maxAgeMs) return Promise.resolve(snapshot);
    reading ||= read().then((next) => { snapshot = next; return next; })
      .catch((error) => { log(`snapshot read failed: ${error.message}`); return snapshot; })
      .finally(() => { readAt = now(); reading = null; });
    return reading;
  }
  // `fresh: true` keeps the cached readings but re-reads which account each pane runs on, so a pane quota
  // recovery just moved is judged by its new account (lsrc:0, 2026-10-19).
  return async (paneKey, { fresh: freshPanes = false } = {}) => {
    let current = await fresh();
    if (freshPanes && current) current = withPanesInUse(current, await readPanes(), profiles());
    const account = current?.accounts?.find((candidate) => candidate.ok && candidate.inUse?.includes(paneKey));
    return account
      ? { account: { name: account.name || account.profile?.key || null, key: account.profile?.key || null, provider: account.provider || null },
        windows: accountWindows(account) }
      : null;
  };
}
