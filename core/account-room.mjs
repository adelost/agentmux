import { claudeWeeklyRoom } from "./claude-quota-recovery.mjs";
import { codexAccountHasRoom } from "./codex-limit-recovery.mjs";

const codexWeeklyPercent = account => account.limits?.find(limit => limit.limitId === "codex")
  ?.windows?.find(window => window.windowMinutes === 10080)?.usedPercent;

/** WHAT: Returns the account with most weekly room below reserve. WHY: Keeps alarms and wind-down moves on one ordering. */
export function accountWithRoom(accounts, engine, { reservePercent = 90 } = {}) {
  let best = null;
  for (const account of accounts || []) {
    if (!account?.ok || account.provider !== engine) continue;
    const weekly = engine === "codex" ? codexWeeklyPercent(account) : null;
    const usedPercent = engine === "claude"
      ? claudeWeeklyRoom(account, { reservePercent })
      : codexAccountHasRoom(account) && Number(weekly) < reservePercent ? Number(weekly) : null;
    if (usedPercent !== null && (!best || usedPercent < best.usedPercent)) {
      best = { name: account.name || account.profile?.key, profileId: account.profile?.id, usedPercent,
        profileKeys: [account.profile?.key, ...(account.sharedBy || []).map(member => member.key)].filter(Boolean) };
    }
  }
  return best;
}
