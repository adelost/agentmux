// Circuit breaker against identical-short-message loops in the Discord→pane path.
//
// A Discord client bug, an Anthropic rating-prompt modal, or a user with a
// stuck button can send the same short message dozens of times in a row.
// Each turn bills tokens and may itself trigger another identical reply,
// forming a feedback loop. This module caps that: after N identical short
// messages inside a sliding window, forwarding to the pane pauses until
// something different comes in.
//
// Scope: user → pane direction only. Pane → Discord responses are not
// cost-critical and aren't guarded here.
//
// Pure function. State is owned by the caller (createState() in index.mjs)
// so the circuit-breaker survives process restarts.

export const DEFAULTS = {
  enabled: true,
  threshold: 3,      // identical-short msgs before we block
  windowMs: 30_000,  // sliding window for "identical" matching
  shortLen: 10,      // messages longer than this don't count as loop-candidates
};

/**
 * Read config from env + defaults. Separated so tests can construct configs
 * without touching process.env.
 *
 * @param {object} [env] - defaults to process.env
 * @returns {{enabled:boolean, threshold:number, windowMs:number, shortLen:number}}
 */
export function readLoopGuardConfig(env = process.env) {
  const enabled = (env.LOOP_GUARD_ENABLED ?? "true").toLowerCase() !== "false";
  const threshold = parseInt(env.LOOP_GUARD_THRESHOLD ?? "") || DEFAULTS.threshold;
  const windowMs = parseInt(env.LOOP_GUARD_WINDOW_MS ?? "") || DEFAULTS.windowMs;
  const shortLen = parseInt(env.LOOP_GUARD_SHORT_LEN ?? "") || DEFAULTS.shortLen;
  return { enabled, threshold, windowMs, shortLen };
}

/**
 * Inspect one incoming message against the loop-guard window for its pane.
 *
 * Mutates `entry` in place (adds to last_msgs / resets / updates warning ts)
 * so the caller can persist it back to state in one shot after the call.
 *
 * Contract:
 *   - Long messages (> shortLen) always reset the window and pass through.
 *   - A message that differs from the current window's content resets the
 *     window (user changed tune). Same-msg accumulates.
 *   - At `count >= threshold` the call returns block=true.
 *   - `warn` is true only the FIRST time we block within a windowMs period.
 *     Subsequent blocks inside the same block-period are silent.
 *
 * @param {object} entry  - { last_msgs: [{text, ts_ms}], last_warning_ts: number|null }
 * @param {string} msg    - the incoming message text (raw)
 * @param {number} now    - current timestamp in ms
 * @param {object} config - { enabled, threshold, windowMs, shortLen }
 * @returns {{block:boolean, warn:boolean, count:number, text:string, ageSec:number}}
 */
export function checkLoopGuard(entry, msg, now, config) {
  entry.last_msgs = entry.last_msgs || [];
  entry.last_warning_ts = entry.last_warning_ts ?? null;

  if (!config.enabled) return { block: false, warn: false, count: 0, text: "", ageSec: 0 };

  // 1. Purge stale entries by age
  entry.last_msgs = entry.last_msgs.filter((m) => now - m.ts_ms <= config.windowMs);

  // 2. Normalize incoming text
  const text = msg.trim().toLowerCase();

  // 3. Long messages are never loop candidates. Full reset so a legit long
  //    prompt after a short-msg storm doesn't carry old state.
  const isShort = text.length > 0 && text.length <= config.shortLen;
  if (!isShort) {
    entry.last_msgs = [];
    entry.last_warning_ts = null;
    return { block: false, warn: false, count: 0, text, ageSec: 0 };
  }

  // 4. Window-content differs from incoming → user changed tune, reset first
  const windowDiffers = entry.last_msgs.length > 0 && entry.last_msgs.some((m) => m.text !== text);
  if (windowDiffers) {
    entry.last_msgs = [];
    entry.last_warning_ts = null;
  }

  // 5. Append current
  entry.last_msgs.push({ text, ts_ms: now });
  const count = entry.last_msgs.length;
  const ageSec = Math.round((now - entry.last_msgs[0].ts_ms) / 1000);

  // 6. Below threshold → forward normally
  if (count < config.threshold) {
    return { block: false, warn: false, count, text, ageSec };
  }

  // 7. At/over threshold → block. Warn once per block-period (= windowMs
  //    from the most recent warning).
  const shouldWarn =
    entry.last_warning_ts === null ||
    now - entry.last_warning_ts > config.windowMs;
  if (shouldWarn) entry.last_warning_ts = now;

  return { block: true, warn: shouldWarn, count, text, ageSec };
}

/** Build the paneKey used by state.loop_guard[<key>]. */
export function loopGuardKey(agentName, pane) {
  return `${agentName}:${pane}`;
}

/** Human-friendly warning line posted to Discord on first block. */
export function formatLoopGuardWarning({ text, count, ageSec }) {
  const preview = text.length > 20 ? text.slice(0, 17) + "…" : text;
  return (
    `⚠ Loop detected: '${preview}' × ${count} in ${ageSec}s. Forwarding paused. ` +
    "Reply something different to resume, or run `amux esc` to clear pane state."
  );
}
