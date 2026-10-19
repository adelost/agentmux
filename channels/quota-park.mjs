// Bridge side of parking a pane before its account stops it: the account windows
// of the pane, from the quota snapshot with the panes running on each account.

import { readQuotaSnapshotWithPanes } from "../core/quota-in-use.mjs";
import { quotaAccountCatalog } from "../core/quota-profiles.mjs";
import { accountWindows } from "../core/quota-park.mjs";

/**
 * WHAT: Returns a reader of one pane's account windows from a snapshot at most five minutes old.
 * WHY: Keeps the minute poll from reading quota and pane homes for every pane.
 */
export function createQuotaParkFacts({
  read = () => readQuotaSnapshotWithPanes({ profiles: quotaAccountCatalog().filter((profile) => profile.provider !== "kimi") }),
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
  return async (paneKey) => {
    const account = (await fresh())?.accounts?.find((candidate) => candidate.ok && candidate.inUse?.includes(paneKey));
    return account ? accountWindows(account) : null;
  };
}
