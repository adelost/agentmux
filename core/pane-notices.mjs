// One notice per journal event a pane's channel has not been told about,
// such as a compaction or a turn no model answered.

import { compactCauseForEvent, compactionNoticeText, compactionsToAnnounce } from "./compaction-notice.mjs";
import { compactReceipt } from "./compact-receipts.mjs";
import { recordCompactCall } from "./compact-log.mjs";

/**
 * WHAT: Reports journal events a pane's channel has not been told about, once each.
 * WHY: Keeps a restart from repeating old notices or swallowing new ones.
 */
export async function announceNewPaneEvents({ state, stateKey, channelId, events = [], send, text, log, paneName, kind, afterSend = () => {} }) {
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
    await afterSend(unseen);
    stateByChannel[channelId] = [...new Set([...seen, ...visibleIds])].slice(-100);
    state.set(stateKey, stateByChannel);
    log(`${paneName} → ${channelId} (${kind} notice x${unseen.length})`);
  } catch (err) {
    log(`${kind} notice failed for ${paneName}: ${err.message}`);
  }
}

/** WHAT: Reports compactions with their receipt cause. WHY: Keeps journal-only manual compacts in the same log as bridge-triggered ones. */
export function announceCompactions({ state, paneName, sessionPath, events, ...notice }) {
  const matched = event => compactCauseForEvent(event, compactReceipt(state, paneName), sessionPath);
  return announceNewPaneEvents({ ...notice, state, paneName, events, kind: "compaction",
    text: unseen => compactionNoticeText(paneName, unseen.map(event => ({ ...event, cause: matched(event) }))),
    afterSend: unseen => {
      const receipt = compactReceipt(state, paneName);
      for (const event of unseen) {
        const cause = matched(event);
        if (cause && ["bridge", "account switch", "nightly", "before stop"].includes(receipt?.source)) continue;
        recordCompactCall({ at: event.timestamp, pane: paneName, source: cause ? receipt.source || "manual" : "native-journal", outcome: "compacted",
          reason: cause || "cause unavailable", beforeTokens: cause ? receipt.beforeTokens ?? null : null, afterTokens: null });
      }
    } });
}
