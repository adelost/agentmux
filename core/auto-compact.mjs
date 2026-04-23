// Decides when to warn about / fire auto-/compact for a pane.
// Pure function — state (warnings Map) is owned by the bridge caller so
// tests can inject stable inputs and time.
//
// Contract: caller polls each pane on an interval (e.g. every 30s),
// reads current status + context% + pane_in_mode, then feeds them to
// decideAutoCompactAction. The returned action tells the caller what
// side-effect to apply (post a Discord warning, send /compact to the
// pane, clear pending warning).

export const DEFAULT_CONFIG = {
  enabled: true,
  threshold: 70,          // percent context
  graceMs: 60_000,        // 1 minute between warn and fire
  pollMs: 60_000,         // poll cadence in the bridge.
                          // Matched to graceMs so each pane gets one decide
                          // per grace window — simple, not hacky. Worst-case
                          // latency from threshold crossing to compact is
                          // pollMs + graceMs (~2 min). Each poll queries
                          // ~3 tmux execs per pane; trivial overhead even
                          // with 30 panes. Override via AUTO_COMPACT_POLL_MS.
  minIdleMs: 300_000,     // 5 minutes. Conversation must have been silent
                          // (no jsonl turns) this long before we even
                          // consider warning. Protects against "between
                          // turns" false-positives where the pane shows
                          // the idle prompt char but the operator is just
                          // thinking about the next message.
};

export function parseAutoCompactConfig(env = process.env) {
  return {
    enabled: env.AUTO_COMPACT_ENABLED !== "false",
    threshold: parseInt(env.AUTO_COMPACT_WARN_THRESHOLD || DEFAULT_CONFIG.threshold, 10),
    graceMs: parseInt(env.AUTO_COMPACT_GRACE_MS || DEFAULT_CONFIG.graceMs, 10),
    pollMs: parseInt(env.AUTO_COMPACT_POLL_MS || DEFAULT_CONFIG.pollMs, 10),
    minIdleMs: parseInt(env.AUTO_COMPACT_MIN_IDLE_MS || DEFAULT_CONFIG.minIdleMs, 10),
  };
}

// Statuses that count as "active". Everything else is treated as idle
// enough to safely compact once the grace window elapses.
const ACTIVE_STATUSES = new Set(["working", "resume"]);

/**
 * Decide what the poll loop should do for one pane this tick.
 *
 * @param {object} args
 * @param {string} args.paneKey — "agent:pane" identifier
 * @param {string} args.status — getPaneStatus output
 * @param {number|null} args.contextPercent — 0-100 or null if unreadable
 * @param {string} args.paneInMode — tmux display -p '#{pane_in_mode}' output, "1" when in copy/view
 * @param {number|null} args.lastActivityMs — ms timestamp of most recent jsonl
 *   turn, or null if unknown / no turns yet. "Activity" = any user or
 *   assistant turn, not just tool calls. Null skips the min-idle gate
 *   (can't prove freshness either way).
 * @param {Map} args.warnings — Map<paneKey, { warned_at: ms }>
 * @param {object} args.config — { enabled, threshold, graceMs, minIdleMs }
 * @param {number} args.now — current ms timestamp
 * @returns {{ action: "none"|"warn"|"compact"|"cancel", reason?: string }}
 */
export function decideAutoCompactAction({
  paneKey,
  status,
  contextPercent,
  paneInMode,
  lastActivityMs = null,
  warnings,
  config,
  now,
}) {
  if (!config.enabled) return { action: "none", reason: "disabled" };

  const existing = warnings.get(paneKey);
  const isActive = ACTIVE_STATUSES.has(status);
  const inScrollMode = paneInMode === "1" || paneInMode === 1;

  // Activity or scroll-mode → cancel any pending warning and do nothing.
  // User is doing something we shouldn't interrupt.
  if (isActive || inScrollMode) {
    if (existing) return { action: "cancel", reason: isActive ? "pane active" : "in copy-mode" };
    return { action: "none" };
  }

  // No/unknown context% — can't decide.
  if (contextPercent == null || !Number.isFinite(contextPercent)) {
    return { action: "none", reason: "no context data" };
  }

  // Below threshold — pane doesn't need compacting; drop any stale warning.
  if (contextPercent < config.threshold) {
    if (existing) return { action: "cancel", reason: "below threshold" };
    return { action: "none" };
  }

  // Min-idle gate: the pane might show the idle prompt char in tmux, but
  // if there's been a conversation turn in the last few minutes the
  // operator is probably mid-thought between turns. Skip entirely until
  // the conversation has actually stalled. Null lastActivityMs means the
  // jsonl is unreadable or empty — fall through since we can't prove
  // freshness; the grace period still protects fires.
  if (lastActivityMs != null && Number.isFinite(lastActivityMs)) {
    const idleMs = now - lastActivityMs;
    if (idleMs < config.minIdleMs) {
      // If a prior warning is on file, something's changed recently that
      // we couldn't detect through status — cancel to reset.
      if (existing) return { action: "cancel", reason: `recent activity (${Math.round(idleMs / 1000)}s < ${Math.round(config.minIdleMs / 1000)}s min-idle)` };
      return { action: "none", reason: `recent turn ${Math.round(idleMs / 1000)}s ago, need ${Math.round(config.minIdleMs / 1000)}s of silence first` };
    }
  }

  // Over threshold + idle long enough. First cross → warn. Second cross after grace → fire.
  if (!existing) {
    return { action: "warn", reason: `idle at ${contextPercent}% ≥ ${config.threshold}%` };
  }

  if (now - existing.warned_at >= config.graceMs) {
    return { action: "compact", reason: `grace elapsed, still ${contextPercent}% idle` };
  }

  const remaining = Math.ceil((config.graceMs - (now - existing.warned_at)) / 1000);
  return { action: "none", reason: `grace period, ${remaining}s remaining` };
}

/**
 * Human-readable warning message posted to the pane's Discord channel.
 * Kept here so tests can assert exact format and so the bridge doesn't
 * own copy.
 */
export function formatWarningMessage(paneKey, contextPercent, graceMs) {
  const secs = Math.round(graceMs / 1000);
  return `⚠ Auto-compact in ${secs}s: **${paneKey}** is at ${contextPercent}% context and idle. Type anything (here or in tmux) to cancel.`;
}

export function formatCompactedMessage(paneKey, contextPercent) {
  return `🗜 Auto-compacting **${paneKey}** (was ${contextPercent}%). Summary preserves recent context.`;
}
