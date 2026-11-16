import { getAgent } from "../cli/config.mjs";
import { selectedCodexProfile } from "./codex-profiles.mjs";
import { readQuotaSnapshotWithPanes } from "./quota-in-use.mjs";
import { runtimeAgentsPath } from "./runtime-defaults.mjs";
import { createState } from "./state.mjs";

const profileKeys = account => new Set([account?.profile?.key, ...(account?.sharedBy || []).map(item => item.key)].filter(Boolean));

/** WHAT: Checks the configured target engine. WHY: Keeps Claude delivery out of all builder-cap reads. */
export function isConfiguredCodex(name, pane, configPath = runtimeAgentsPath()) {
  try { return /\bcodex\b/u.test(String(getAgent(configPath, name).panes?.[pane]?.cmd || "")); }
  catch { return false; }
}

/** WHAT: Resolves a sleeping Codex target's account and queued peers. WHY: Keeps a wake on the same cap as running panes. */
export function createBuilderCapFacts({ factsFor, queue, configPath = runtimeAgentsPath(),
  state = createState(process.env.STATE_FILE || "/tmp/agentmux-state.json"), readSnapshot = readQuotaSnapshotWithPanes,
  configuredKey = (name, pane) => {
    try {
      if (!isConfiguredCodex(name, pane, configPath)) return null;
      return `codex:${selectedCodexProfile(state, name, pane).id}`;
    } catch { return null; }
  } } = {}) {
  return async (paneKey, options) => {
    const [name, index] = paneKey.split(":"), pane = Number(index);
    const original = await factsFor(paneKey, options);
    if (original?.account?.provider && original.account.provider !== "codex") return original;
    const selected = configuredKey(name, pane);
    if (!original?.account && !selected) return original;
    let accounts = original?.accounts;
    if (!accounts) { try { accounts = (await readSnapshot())?.accounts; } catch { return { unknownCapTarget: true }; } }
    const account = original?.account ? accounts?.find(item => item.inUse?.includes(paneKey))
      : accounts?.find(item => profileKeys(item).has(selected));
    if (!account) return { unknownCapTarget: true };
    const live = new Set(accounts.flatMap(item => item.inUse || [])), accepted = profileKeys(account);
    const dormantTargets = queue.targets().flatMap(target => {
      const key = `${target.agentName}:${target.pane}`;
      return !live.has(key) && accepted.has(configuredKey(target.agentName, target.pane)) ? [key] : [];
    });
    if (!live.has(paneKey) && !dormantTargets.includes(paneKey)) dormantTargets.push(paneKey);
    const expanded = { ...account, inUse: [...new Set([...(account.inUse || []), ...dormantTargets])] };
    return { ...original, account: { ...expanded, provider: "codex" },
      accounts: accounts.map(item => item === account ? expanded : item), dormantTargets };
  };
}
