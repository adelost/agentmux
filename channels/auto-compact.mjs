// Bridge-side poll loop that drives decideAutoCompactAction for every
// configured pane, fires Discord warnings, and sends /compact when the
// grace window elapses. Keeps just enough state (warnings + in-flight
// compact lock) to avoid double-firing. Pure decision logic lives in
// core/auto-compact.mjs; this file is the I/O integration layer.

import {
  decideAutoCompactAction,
  resolveActivityMs,
  formatWarningMessage,
  formatCompactedMessage,
} from "../core/auto-compact.mjs";
import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { getContextFromPane, getContextPercent } from "../core/context.mjs";
import { detectPaneStatus } from "../cli/format.mjs";
import { readLastTurns, panePathFor } from "../core/jsonl-reader.mjs";
import { readLastTurnsCodex } from "../core/codex-jsonl-reader.mjs";
import { statSync } from "fs";

// Panes that have warnings pending (paneKey → { warned_at: ms }).
// Panes currently mid-compact (paneKey string).
// Both maps are in-memory — warnings are cheap to re-derive after a
// bridge restart (next poll re-warns if still over threshold).

export function createAutoCompact({
  agent,
  agentsYamlPath,
  discord,
  tmux,      // tmux exec function, same signature as createTmuxContext provides
  config,
  log = (msg) => console.log(`auto-compact | ${msg}`),
}) {
  const warnings = new Map();
  const compacting = new Set();
  // paneKey → context% at last /compact fire. Drives verify-before-refire in
  // decideAutoCompactAction: if context doesn't drop below this, the compact
  // was a no-op and we stop re-firing. Cleared on "cancel" (context fell below
  // threshold / pane went active).
  const compactFloors = new Map();
  // paneKey → ms of the last WARNING posted to Discord. Bounds the user-facing
  // warning rate per pane: a pane that flickers status (codex stream redraws,
  // a flapping capture) makes decide() oscillate warn↔cancel, which would re-post
  // a fresh "Auto-compact in 60s" every poll (the observed skybar:4 flood). The
  // decision/state machine still runs every tick (so warn→grace→compact is
  // unaffected); we only rate-limit the Discord POST. Naturally expires.
  const lastWarnPostAt = new Map();
  let intervalId = null;

  // Panes shorter than config.minPaneHeight (rows) can't render a coherent
  // status block, so a tmux capture of them is a soup of overlapping redraw
  // frames — the context parser latches onto stale/transient frames (we saw a
  // 1-row pane read as "100%" while actually at 28%, triggering endless
  // /compact). We can't decide safely without trustworthy data, so we skip
  // them. The failure mode is one-directional and safe: worst case a tiny pane
  // never auto-compacts (the user can still `amux compact` it by hand).
  const MIN_PANE_HEIGHT = config.minPaneHeight ?? 6;

  function paneDialect(agentConfig, paneIdx) {
    const pane = agentConfig.panes?.[paneIdx] || {};
    const cmd = String(pane.cmd || pane.name || "");
    if (/codex/i.test(cmd)) return "codex";
    if (/claude/i.test(cmd)) return "claude";
    return null;
  }

  async function inspect(agentConfig, paneIdx) {
    // Mirrors cli/commands.mjs inspectPane just enough for our decision.
    // Wrapped in try/catch because any pane quirk (just-spawned, dead
    // session) should degrade to "no data" rather than crash the poller.
    let status = "unknown";
    let content = "";
    let paneInMode = "0";
    let paneHeight = null;
    let lastActivityMs = null;

    try {
      content = await agent.capturePane(agentConfig.name, paneIdx, 100);
    } catch {}

    try {
      status = detectPaneStatus(content);
    } catch {
      status = "unknown";
    }

    try {
      const { stdout } = await tmux(`display-message -t '${agentConfig.name}:.${paneIdx}' -p '#{pane_in_mode} #{pane_height}'`);
      const parts = (stdout || "").trim().split(/\s+/);
      paneInMode = parts[0] || "0";
      const h = parseInt(parts[1], 10);
      if (Number.isFinite(h)) paneHeight = h;
    } catch {}

    const paneDir = panePathFor(agentConfig, paneIdx);
    const dialect = paneDialect(agentConfig, paneIdx);
    const ctxInfo = dialect === "codex"
      ? getContextPercent(paneDir, "codex")
      : dialect === "claude"
        ? getContextFromPane(content, paneDir) || getContextPercent(paneDir, "claude")
        : null;
    const contextPercent = ctxInfo?.percent ?? null;

    // Most-recent activity timestamp, used by the min-idle gate to tell a
    // truly-stalled pane apart from one that just paused between turns.
    //
    // "Activity" is a REAL conversational turn, NOT "the jsonl was written for
    // any reason". Claude Code touches the session file for non-turn records
    // (system/mode/attachment reminders, harness rewrites) without appending a
    // newer-dated turn — we measured a file whose mtime was "now" while its
    // newest turn was >24h old. The previous code did Math.max(turnMs, fileMs),
    // which let that mtime noise pose as activity: idle panes read as "active
    // 37s ago", so the min-idle gate cancelled the pending auto-compact warning
    // every poll and the warn->grace->compact cycle never matured (the warning
    // flood Mattias kept seeing). resolveActivityMs() trusts the turn timestamp
    // and only falls back to mtime when no turn is readable (fresh session). A
    // pane that is genuinely mid-stream reports status working/resume, which the
    // isActive check cancels before this gate is even reached.
    //
    // (Earlier dead-code era: readLastTurns returns { turns, jsonlFile }; the
    // original guard read `.length` on that OBJECT so lastActivityMs stayed null
    // for every pane and the gate never ran. That part is fixed too — we read
    // the right per-dialect store and parse the newest turn.)
    //
    // Tail sizing (the 8th-time hole, claw:1 2026-07-02): a 64KB tail parses
    // ZERO turns on high-context sessions — one giant turn's records (huge tool
    // results, long assistant messages) span more than 64KB, and groupIntoTurns
    // only opens a turn at a string-content user event. Zero turns made turnMs
    // NaN, resolveActivityMs fell back to mtime (touched even while idle), and
    // the genuinely-idle pane read as "active" — min-idle cancelled the warning
    // every poll and /compact never fired. The panes over threshold are exactly
    // the panes with giant turns, so the bug preferentially hit its own target
    // population. Two-part fix: escalate the tail until a turn is found, and
    // only let mtime stand in when the parse covered the WHOLE file.
    try {
      const reader = dialect === "codex" ? readLastTurnsCodex : readLastTurns;
      let usedTailBytes = 64 * 1024;
      let res = reader(paneDir, { limit: 1, tailBytes: usedTailBytes });
      let newest = res?.turns?.[res.turns.length - 1];
      // No turn in the small tail ≠ no turn in the file. Escalate before
      // concluding anything (claw:1's 201MB session needed 256KB).
      if (res && !newest) {
        for (const tailBytes of [1024 * 1024, 8 * 1024 * 1024]) {
          usedTailBytes = tailBytes;
          res = reader(paneDir, { limit: 1, tailBytes });
          newest = res?.turns?.[res.turns.length - 1];
          if (newest) break;
        }
      }
      if (res) {
        const turnMs = newest?.timestamp ? Date.parse(newest.timestamp) : NaN;
        let fileMtimeMs = NaN;
        let fileFullyRead = false;
        if (res.jsonlFile) {
          try {
            const st = statSync(res.jsonlFile);
            fileMtimeMs = st.mtimeMs;
            fileFullyRead = st.size <= usedTailBytes;
          } catch {}
        }
        lastActivityMs = resolveActivityMs({ turnMs, fileMtimeMs, fileFullyRead });
      }
    } catch {}

    return { status, contextPercent, paneInMode, paneHeight, lastActivityMs };
  }

  async function fireCompact(agentName, paneIdx, paneKey, contextPercent) {
    if (compacting.has(paneKey)) return;
    compacting.add(paneKey);
    try {
      await agent.sendOnly(agentName, "/compact", paneIdx);
      log(`fired /compact on ${paneKey} (was ${contextPercent}%)`);

      const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
      if (channelId && discord) {
        try {
          await discord.send(channelId, formatCompactedMessage(paneKey, contextPercent));
        } catch (err) {
          log(`compacted-notice send failed for ${paneKey}: ${err.message}`);
        }
        // Refresh channel topic on compact — the only trigger that hits
        // Discord's topic-PATCH API. Auto-compact is rare per pane (hours
        // between events), so 2-edits-per-10min limit stays comfortable.
        try {
          const { setChannelTopicThrottled } = await import("../cli/send-notify.mjs");
          const stamp = new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
          const topic = `[${paneKey}] compacted · ${stamp}`;
          const r = await setChannelTopicThrottled(channelId, topic);
          if (r && !r.updated && r.reason && !r.reason.startsWith("throttled") && !r.reason.startsWith("unchanged")) {
            log(`topic ${paneKey} → ${channelId}: ${r.reason}`);
          }
        } catch (err) {
          log(`topic patch failed for ${paneKey}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`fire failed for ${paneKey}: ${err.message}`);
    } finally {
      // Release lock after the configured window. /compact takes 30-90s; we
      // want to prevent a follow-up poll from re-firing while the pane still
      // shows old context% pre-summary.
      setTimeout(() => compacting.delete(paneKey), config.compactLockMs ?? 120_000);
    }
  }

  async function postWarning(agentName, paneIdx, paneKey, contextPercent) {
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) {
      log(`no discord channel for ${paneKey}, warning suppressed (will still fire at grace end)`);
      return;
    }
    try {
      await discord.send(channelId, formatWarningMessage(paneKey, contextPercent, config.graceMs));
      log(`warned ${paneKey} at ${contextPercent}%`);
    } catch (err) {
      log(`warning send failed for ${paneKey}: ${err.message}`);
    }
  }

  async function tick() {
    if (!config.enabled) return;

    let agents;
    try {
      agents = listAgents(agentsYamlPath);
    } catch {
      return;
    }

    const now = Date.now();

    for (const a of agents) {
      const panes = Array.isArray(a.panes) ? a.panes : [];
      for (let i = 0; i < panes.length; i++) {
        const paneKey = `${a.name}:${i}`;
        if (compacting.has(paneKey)) continue;

        // Codex panes run on AUTO (Mattias 2026-06-13): codex has its own
        // server-enforced context cap + native auto-compaction, and amux's
        // "/compact" is a Claude command that does not meaningfully drive it.
        // amux must not touch codex panes — skip and clear any leftover state.
        // Re-enable via AUTO_COMPACT_CODEX=true if that ever changes.
        if (!config.codexEnabled && paneDialect(a, i) === "codex") {
          if (warnings.has(paneKey) || compactFloors.has(paneKey) || lastWarnPostAt.has(paneKey)) {
            warnings.delete(paneKey);
            compactFloors.delete(paneKey);
            lastWarnPostAt.delete(paneKey);
          }
          continue;
        }

        const { status, contextPercent, paneInMode, paneHeight, lastActivityMs } = await inspect(a, i);

        // Too small to read reliably — skip rather than act on redraw-soup.
        if (paneHeight != null && paneHeight < MIN_PANE_HEIGHT) {
          if (warnings.has(paneKey) || compactFloors.has(paneKey)) {
            warnings.delete(paneKey);
            compactFloors.delete(paneKey);
          }
          continue;
        }

        const decision = decideAutoCompactAction({
          paneKey,
          status,
          contextPercent,
          paneInMode,
          lastActivityMs,
          warnings,
          compactFloors,
          config,
          now,
        });

        if (decision.action === "warn") {
          warnings.set(paneKey, { warned_at: now });
          // Rate-limit the Discord post (not the state machine): a status-
          // flickering pane re-enters "warn" every poll, which would spam the
          // channel. Post at most once per warnCooldownMs per pane.
          const lastPost = lastWarnPostAt.get(paneKey);
          const cooldown = config.warnCooldownMs ?? 0;
          if (lastPost == null || now - lastPost >= cooldown) {
            lastWarnPostAt.set(paneKey, now);
            await postWarning(a.name, i, paneKey, contextPercent);
          }
        } else if (decision.action === "compact") {
          warnings.delete(paneKey);
          // Record the level we fired at BEFORE the compact runs. Next tick
          // (after the in-flight lock clears) compares against it: if context
          // didn't drop below this, the compact was a no-op and decide returns
          // "suppress" instead of firing again.
          compactFloors.set(paneKey, contextPercent);
          await fireCompact(a.name, i, paneKey, contextPercent);
        } else if (decision.action === "suppress") {
          // Prior /compact didn't help. Clear the pending warning so it can't
          // mature into another fire; keep the floor so we stay suppressed.
          if (warnings.has(paneKey)) {
            warnings.delete(paneKey);
            log(`suppressing ${paneKey} (${decision.reason})`);
          }
        } else if (decision.action === "cancel") {
          warnings.delete(paneKey);
          compactFloors.delete(paneKey);
          log(`cancelled warning for ${paneKey} (${decision.reason})`);
        }
        // action === "none" → do nothing
      }
    }
  }

  function start() {
    if (!config.enabled) {
      log(`disabled (AUTO_COMPACT_ENABLED=false)`);
      return;
    }
    if (intervalId) return;
    log(`enabled | threshold=${config.threshold}% grace=${Math.round(config.graceMs / 1000)}s poll=${Math.round(config.pollMs / 1000)}s min-idle=${Math.round(config.minIdleMs / 1000)}s`);
    intervalId = setInterval(() => {
      tick().catch((err) => log(`tick failed: ${err.message}`));
    }, config.pollMs);
  }

  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  // Expose internals for tests + introspection (amux done warnings column)
  function getWarnings() {
    const out = {};
    for (const [k, v] of warnings) out[k] = v;
    return out;
  }

  return { start, stop, tick, getWarnings };
}
