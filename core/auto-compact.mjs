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
  codexEnabled: false,    // Auto-compact is OFF for codex panes by default.
                          // Codex enforces its own server-side context cap and
                          // runs native auto-compaction, and amux's "/compact"
                          // is a Claude command that doesn't drive codex — so
                          // amux would only spam warnings at a pane it can't
                          // actually shrink. Let codex run on auto. Flip with
                          // AUTO_COMPACT_CODEX=true.
  threshold: 70,          // percent context
  graceMs: 60_000,        // 1 minute between warn and fire
  pollMs: 60_000,         // poll cadence in the bridge.
                          // Matched to graceMs so each pane gets one decide
                          // per grace window — simple, not hacky. Worst-case
                          // latency from threshold crossing to compact is
                          // pollMs + graceMs (~2 min). Each poll queries
                          // ~3 tmux execs per pane; trivial overhead even
                          // with 30 panes. Override via AUTO_COMPACT_POLL_MS.
  compactLockMs: 120_000, // After firing /compact, ignore the pane this long
                          // so an in-flight compact (30-90s) isn't re-fired
                          // while the pane still shows pre-summary context%.
  minPaneHeight: 6,       // Panes shorter than this (rows) can't render a
                          // coherent status block. A 100-line capture of a
                          // 1-2 row WORKING pane is a soup of overlapping
                          // redraw frames with conflicting context% — we saw a
                          // 1-row pane read as 100% while actually at 28%, which
                          // drove the /compact runaway. We can't decide on
                          // unreadable data, so we skip such panes. Tune down
                          // (e.g. 4) via AUTO_COMPACT_MIN_PANE_HEIGHT if you run
                          // a tiled layout of small panes and want more of them
                          // covered — the verify-before-refire guard still
                          // bounds any misfire.
  minIdleMs: 300_000,     // 5 minutes. Conversation must have been silent
                          // (no jsonl turns) this long before we even
                          // consider warning. Protects against "between
                          // turns" false-positives where the pane shows
                          // the idle prompt char but the operator is just
                          // thinking about the next message.
  warnCooldownMs: 600_000, // 10 minutes. Minimum spacing between Discord
                          // WARNING posts for the SAME pane (bridge-enforced).
                          // The decision loop still runs every poll, so
                          // warn→grace→compact is unaffected; this only stops a
                          // status-flickering pane (e.g. codex stream redraws
                          // making decide() oscillate warn↔cancel) from
                          // re-posting "Auto-compact in 60s" every tick and
                          // flooding the channel. Override via
                          // AUTO_COMPACT_WARN_COOLDOWN_MS.
};

export function parseAutoCompactConfig(env = process.env) {
  return {
    enabled: env.AUTO_COMPACT_ENABLED !== "false",
    codexEnabled: env.AUTO_COMPACT_CODEX === "true",
    threshold: parseInt(env.AUTO_COMPACT_WARN_THRESHOLD || DEFAULT_CONFIG.threshold, 10),
    graceMs: parseInt(env.AUTO_COMPACT_GRACE_MS || DEFAULT_CONFIG.graceMs, 10),
    pollMs: parseInt(env.AUTO_COMPACT_POLL_MS || DEFAULT_CONFIG.pollMs, 10),
    compactLockMs: parseInt(env.AUTO_COMPACT_LOCK_MS || DEFAULT_CONFIG.compactLockMs, 10),
    minPaneHeight: parseInt(env.AUTO_COMPACT_MIN_PANE_HEIGHT || DEFAULT_CONFIG.minPaneHeight, 10),
    minIdleMs: parseInt(env.AUTO_COMPACT_MIN_IDLE_MS || DEFAULT_CONFIG.minIdleMs, 10),
    warnCooldownMs: parseInt(env.AUTO_COMPACT_WARN_COOLDOWN_MS || DEFAULT_CONFIG.warnCooldownMs, 10),
  };
}

// Statuses that count as "active". Everything else is treated as idle
// enough to safely compact once the grace window elapses.
const ACTIVE_STATUSES = new Set(["working", "resume"]);

/**
 * Pick the timestamp the min-idle gate should reason about for one pane.
 *
 * "Activity" means a REAL conversational turn — a user/assistant message — not
 * "the session file was written for any reason". This distinction is the whole
 * bug class behind the recurring auto-compact warning flood:
 *
 *   Claude Code touches the pane jsonl for non-turn records (system/mode/
 *   attachment reminders, harness rewrites, periodic state) WITHOUT appending a
 *   newer-dated turn. We observed a session file whose mtime was "now" while its
 *   newest actual turn was >24h old. The old inspect() took
 *   Math.max(turnMs, fileMtimeMs), so that mtime noise masqueraded as activity:
 *   a genuinely-idle pane read as "active 37s ago", the min-idle gate cancelled
 *   its pending auto-compact warning every poll, and the warn->grace->compact
 *   state machine never matured (it only fired in the rare ~5min window where
 *   the mtime happened to stay quiet). The user saw "Auto-compact in 60s"
 *   re-posted for ~40min before a compact finally landed.
 *
 * So: the turn timestamp is the activity signal. File mtime is only a
 * last-resort proxy when there is NO readable turn at all AND we actually read
 * the whole file (a fresh session that hasn't flushed a turn yet). It must
 * never override an existing (older) turn.
 *
 * THE 8TH-TIME HOLE (claw:1, 2026-07-02): "no readable turn" is NOT the same
 * as "fresh session". The caller reads a bounded TAIL of the jsonl, and a
 * high-context pane (the exact population auto-compact targets) has giant
 * turns — claw:1's 201MB session needed a 256KB tail to reach its newest
 * user prompt, so the 64KB tail parsed ZERO turns. turnMs came back NaN, the
 * mtime fallback kicked in, and since Claude Code touches the jsonl while
 * idle, the genuinely-idle pane read as "active seconds ago" — min-idle
 * cancelled the pending warning every poll and the compact never fired
 * (warnings re-posted every ~10-24 min via warn-cooldown, the observed
 * flood). Selection bias made this hit precisely the panes over threshold.
 *
 * Fix: mtime is only trusted when `fileFullyRead` says the parse covered the
 * ENTIRE file. A partial tail with no turn returns null — "unknown", which
 * makes decide() skip the min-idle gate (grace still protects fires) instead
 * of fabricating freshness. Callers should ALSO retry with a bigger tail
 * before giving up (see channels/auto-compact.mjs inspect()).
 *
 * A pane that is genuinely mid-generation already reports status working/resume,
 * which the isActive check cancels earlier than this gate — so dropping mtime
 * from the activity signal does not re-expose the "warned mid-stream" case the
 * mtime fallback was originally (over-broadly) added to cover.
 *
 * @param {object} args
 * @param {number|null} args.turnMs — ms timestamp of the newest finalized turn, or null/NaN
 * @param {number|null} args.fileMtimeMs — session-file mtime in ms, or null/NaN
 * @param {boolean} [args.fileFullyRead=true] — true only when the turn parse
 *   covered the whole session file; a partial tail must not fall back to mtime
 * @returns {number|null} the activity timestamp, or null if nothing is readable
 */
export function resolveActivityMs({ turnMs = null, fileMtimeMs = null, fileFullyRead = true } = {}) {
  if (Number.isFinite(turnMs)) return turnMs;
  if (fileFullyRead && Number.isFinite(fileMtimeMs)) return fileMtimeMs;
  return null;
}

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
 * @param {Map} args.compactFloors — Map<paneKey, number>. The context% at which
 *   we last FIRED /compact. Set by the caller after a fire. If a later tick
 *   still reads context ≥ that level, the previous /compact failed to reduce
 *   context (the pane reported "Not enough messages to compact", or genuinely
 *   can't shrink) — re-firing is futile and just spams the pane's input queue.
 *   Cleared by the caller on any "cancel" (context dropped below threshold,
 *   pane went active). Defaults to an empty Map for callers that don't track it.
 * @param {object} args.config — { enabled, threshold, graceMs, minIdleMs }
 * @param {number} args.now — current ms timestamp
 * @returns {{ action: "none"|"warn"|"compact"|"cancel"|"suppress", reason?: string }}
 *   "suppress" = clear any pending warning but KEEP the floor and do not fire;
 *   used when a prior /compact proved ineffective.
 */
export function decideAutoCompactAction({
  paneKey,
  status,
  contextPercent,
  paneInMode,
  lastActivityMs = null,
  warnings,
  compactFloors = new Map(),
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
    if (existing || compactFloors.has(paneKey)) return { action: "cancel", reason: isActive ? "pane active" : "in copy-mode" };
    return { action: "none" };
  }

  // No/unknown context% — can't decide.
  if (contextPercent == null || !Number.isFinite(contextPercent)) {
    return { action: "none", reason: "no context data" };
  }

  // Below threshold — pane doesn't need compacting; drop any stale warning.
  if (contextPercent < config.threshold) {
    if (existing || compactFloors.has(paneKey)) return { action: "cancel", reason: "below threshold" };
    return { action: "none" };
  }

  // Verify-before-refire: if we already fired /compact and context has NOT
  // dropped below the level we fired at, the compact isn't reducing context.
  // Firing again does nothing but queue another /compact into the pane (the
  // observed runaway: dozens of fires, "Not enough messages to compact"). Hold
  // off until context actually changes — a working compact, a finished turn,
  // or /clear drops it below threshold, which clears the floor via "cancel".
  const floor = compactFloors.get(paneKey);
  if (floor != null && contextPercent >= floor) {
    return { action: "suppress", reason: `prior /compact ineffective: still ${contextPercent}% ≥ ${floor}% — not re-firing` };
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
