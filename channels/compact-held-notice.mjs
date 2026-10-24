import { dirname, join } from 'node:path';
import { createState } from '../core/state.mjs';
import { findChannelForPane } from '../cli/config.mjs';
import { formatCompactHeldMessage } from '../core/auto-compact.mjs';

/** WHAT: Stores accepted held-notice causes across bridge reloads. WHY: Keeps journal activity from rearming an unchanged cause. */
export function createCompactHeldNotice({ agentsYamlPath, discord, config, log }) {
  const state = createState(join(dirname(agentsYamlPath), 'compact-held-notices.json'));
  const posting = new Set();
  const clear = key => { if (state.get(key) !== undefined) state.remove(key); };
  const post = async (agentName, paneIdx, paneKey, reason, { lastActivityMs, contextTokens, cause = reason, sessionId = null }) => {
    const evidence = { cause, sessionId, observedAt: Date.now(),
      lastActivityMs: Number.isFinite(lastActivityMs) ? lastActivityMs : null,
      cacheExpiresAt: Number.isFinite(lastActivityMs) ? lastActivityMs + config.warmCacheMs : null };
    if (cause.includes("delivery-pending")) state.updateKey("deliveryHolds", prior => ({ ...(prior || {}), [paneKey]: evidence }));
    const prior = state.get(paneKey);
    if (posting.has(paneKey) || prior?.cause === cause && prior.sessionId === sessionId) return;
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) {
      state.set(paneKey, evidence);
      log(`${paneKey}: compact held (${reason}); no Discord channel to tell`);return;
    }
    posting.add(paneKey);
    try {
      await discord.send(channelId, formatCompactHeldMessage(paneKey, reason, contextTokens, lastActivityMs + config.warmCacheMs));
      state.set(paneKey, evidence);
      log(`${paneKey}: compact held (${reason}); notice sent`);
    } catch (err) { log(`compact-held notice send failed for ${paneKey}: ${err.message}; retrying on the next poll`); }
    finally { posting.delete(paneKey); }
  };
  return { post, clear };
}
