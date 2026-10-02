// One notice per journal event a pane's channel has not been told about,
// such as a compaction or a turn no model answered.

import { compactionsToAnnounce } from "./compaction-notice.mjs";

/**
 * WHAT: Reports journal events a pane's channel has not been told about, once each.
 * WHY: Keeps a restart from repeating old notices or swallowing new ones.
 */
export async function announceNewPaneEvents({ state, stateKey, channelId, events = [], send, text, log, paneName, kind }) {
  const stateByChannel = state.get(stateKey, {}) || {};
  const visibleIds = events.map((event) => event.id).filter(Boolean);
  // Migration seed: an upgrade must not announce history still visible in the
  // startup tail. A channel with nothing visible is seeded empty, so its first
  // event is announced instead of becoming the seed.
  if (!Object.hasOwn(stateByChannel, channelId)) {
    stateByChannel[channelId] = visibleIds.slice(-100);
    state.set(stateKey, stateByChannel);
    return;
  }
  const seen = new Set(stateByChannel[channelId] || []);
  const unseen = compactionsToAnnounce(events, seen);
  if (!unseen.length) return;
  try {
    await send(channelId, await text(unseen));
    stateByChannel[channelId] = [...new Set([...seen, ...visibleIds])].slice(-100);
    state.set(stateKey, stateByChannel);
    log(`${paneName} → ${channelId} (${kind} notice x${unseen.length})`);
  } catch (err) {
    log(`${kind} notice failed for ${paneName}: ${err.message}`);
  }
}
