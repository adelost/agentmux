// Bridge-side poll loop that drives decideAutoCompactAction for every
// configured pane, fires Discord warnings, and sends /compact when the
// grace window elapses. Keeps just enough state (warnings + in-flight
// compact lock) to avoid double-firing. Pure decision logic lives in
// core/auto-compact.mjs; this file is the I/O integration layer.

import {
  compactHeldReason,
  decideAutoCompactAction,
  formatCompactHeldMessage,
  formatWarningMessage,
  refusalNeedsHeldNotice,
  formatCompactedMessage,
  formatCompactFailedMessage,
  formatCompactPostponedMessage,
} from "../core/auto-compact.mjs";
import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { appendEvent } from "../core/events.mjs";
import { notifyUser } from "../cli/send-notify.mjs";
import { getContextFromPane, getContextPercent } from "../core/context.mjs";
import { detectPaneStatus, LIMIT_BANNER } from "../cli/format.mjs";
import { latestPaneStatesCached, mergeStatus } from "../core/events.mjs";
import { sendSlashVerified } from "../core/delivery.mjs";
import { panePathFor } from "../core/jsonl-reader.mjs";
import { latestConversationActivityMs } from "../core/pane-activity.mjs";
import { compactReceiptIsAuthoritative } from "../core/dialects.mjs";
import { activeClaudeLimitReceipt } from "../core/claude-quota-recovery.mjs";
import { formatLimitedAlert } from "../core/quota-format.mjs";
import { parseQuotaRecoveryConfig } from "./quota-recovery.mjs";
import { enteredLimited, nextLimitedMemory, seedLimitedFromLedger } from "./limited-latch.mjs";

// Panes that have warnings pending (paneKey → { warned_at: ms }).
// Panes currently mid-compact (paneKey string).
// Both maps are in-memory — warnings are cheap to re-derive after a
// bridge restart (next poll re-warns if still over threshold).

/** WHAT: Builds the idle compaction controller. WHY: Keeps quota alerts, admission and compaction effects on the shared pane evidence. */
export function createAutoCompact({
  agent,
  deliveryBroker = null,
  agentsYamlPath,
  discord,
  tmux,      // tmux exec function, same signature as createTmuxContext provides
  config,
  contextMaintenance = null,
  log = (msg) => console.log(`auto-compact | ${msg}`),
}) {
  const warnings = new Map();
  // The stop notice names the reset from the journal: the screen banner wraps
  // in narrow panes. Quota recovery resumes only Claude panes.
  const quotaRecoveryEnabled = parseQuotaRecoveryConfig().enabled;
  const claudeStopResetAt = (paneDir) => {
    try { return activeClaudeLimitReceipt(paneDir)?.resetAt ?? null; }
    catch (err) { log(`limit receipt unreadable for ${paneDir}: ${err.message}`); return null; }
  };
  const compacting = new Set();
  // paneKey → context% at last /compact fire. Drives verify-before-refire in
  // decideAutoCompactAction: if context doesn't drop below this, the compact
  // was a no-op and we stop re-firing. Cleared on "cancel" (context fell below
  // threshold / pane went active).
  const compactFloors = new Map();
  const contextSessions = new Map();
  const attemptedActivity = new Map();
  // paneKey → ms of the last WARNING posted to Discord. Bounds the user-facing
  // warning rate per pane: a pane that flickers status (codex stream redraws,
  // a flapping capture) makes decide() oscillate warn↔cancel, which would re-post
  // a fresh "Auto-compact in 60s" every poll (the observed skybar:4 flood). The
  // decision/state machine still runs every tick (so warn→grace→compact is
  // unaffected); we only rate-limit the Discord POST. Naturally expires.
  const lastWarnPostAt = new Map();
  // paneKey → lastActivityMs of the quiet episode already reported as held.
  const heldNotices = new Map();
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
    if (/kimi(?:-code)?/i.test(cmd)) return "kimi";
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
      // Scrape + hook-pushed merge (same rules as getPaneStatus). A fresh
      // pushed "prompt" marks a working pane whose narrow rendering shows
      // no busy-regex — exactly the pane auto-compact must NOT /compact.
      // Capture failure (dead pane) stays "unknown" unmerged.
      status = content
        ? mergeStatus(detectPaneStatus(content),
                      latestPaneStatesCached().get(`${agentConfig.name}:${paneIdx}`)).status
        : "unknown";
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
      : dialect === "kimi"
        ? getContextPercent(paneDir, "kimi")
      : dialect === "claude"
        ? getContextFromPane(content, paneDir) || getContextPercent(paneDir, "claude")
        : null;
    const contextPercent = ctxInfo?.source === "claude-jsonl" && !Number.isFinite(Date.parse(ctxInfo.observedAt))
      ? null : ctxInfo?.percent ?? null;

    // Housekeeping writes must not masquerade as operator activity. The shared
    // reader escalates bounded tails and trusts journal mtime only when the
    // complete session was read and contains no conversational turn.
    try { lastActivityMs = latestConversationActivityMs(paneDir, dialect); }
    catch { lastActivityMs = null; }

    // Asked of the SAME captured tail the status came from, so the latch and
    // the classifier can never disagree about whether the banner is on screen.
    const limitBannerVisible = Boolean(content) && LIMIT_BANNER.test(content);
    const claudeStop = limitBannerVisible && dialect === "claude";
    return { status, contextPercent, contextTokens: dialect === "kimi" ? null : ctxInfo?.tokens ?? null, contextSession: ctxInfo?.sessionId ?? null, paneInMode, paneHeight, lastActivityMs,
             limitBannerVisible, limitResetAt: claudeStop ? claudeStopResetAt(paneDir) : null, autoResume: claudeStop && quotaRecoveryEnabled };
  }

  /** WHAT: Sends one maintenance compact and returns why it was refused before sending, if it was. WHY: Lets the poll loop retry a refusal that spent nothing instead of mistaking it for an ineffective compact. */
  async function fireCompact(agentName, paneIdx, paneKey, contextPercent, dialect) {
    if (compacting.has(paneKey)) return null;
    compacting.add(paneKey);
    let refusal = null;
    try {
      if (contextMaintenance) {
        const result = await contextMaintenance.run(agentName, paneIdx);
        log(`${paneKey}: ${result.compacted ? "compact verified" : result.reason || result.cell || "within policy"}`);
        if (result.attempted && !result.ok) await postCompactFailed(agentName, paneIdx, paneKey, result.detail || result.reason);
        if (!result.ok && !result.attempted) refusal = result.reason ?? "refused before sending";
        return refusal;
      }
      const result = deliveryBroker
        ? await deliveryBroker.enqueueAndWait({
            agentName,
            pane: paneIdx,
            text: "/compact",
            kind: "slash",
            source: "auto-compact",
            idempotencyKey: `auto-compact:${paneKey}:${Date.now()}`,
          })
        : await sendSlashVerified(agent, agentName, paneIdx, "/compact",
            { settleMs: config.slashSettleMs ?? 1200 });
      if (!result.delivered) {
        // The broker owns the durable retry. Do not enqueue a competing
        // compact command merely because the TUI acknowledgement is late.
        log(`/compact ${result.pending ? "durably queued" : "NOT acknowledged"} on ${paneKey}`);
        return;
      }
      const authoritative = compactReceiptIsAuthoritative(dialect);
      log(`${authoritative ? "fired" : "requested"} /compact on ${paneKey} (was ${contextPercent}%)${result.rescues ? ` (rescued x${result.rescues})` : ""}`);

      // No current engine's slash ACK proves compaction. Claude can return a
      // no-op too; actual journal events own the completion notice. Keep the
      // floor to prevent another request while context remains unchanged.
      if (!authoritative) return;

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
      // shows old context% pre-summary. A refusal sent nothing, so nothing is
      // in flight and the next poll may retry.
      if (refusal) compacting.delete(paneKey);
      else setTimeout(() => compacting.delete(paneKey), config.compactLockMs ?? 120_000);
    }
  }

  // lsrc:2, 2026-10-02: the compact was refused while lsrc:3 held the session
  // lease. The floor recorded before the fire then read as "prior /compact
  // ineffective" on every poll, so the warning ended in silence and the pane
  // compacted cold 42 minutes later. A refusal spent nothing: keep the warning
  // and retry each poll until the prompt cache expires (decide → "postpone").
  function keepWarningForRetry(paneKey, warning, reason) {
    compactFloors.delete(paneKey);
    attemptedActivity.delete(paneKey);
    warnings.set(paneKey, { ...warning, refusedReason: reason });
    log(`${paneKey}: compact refused before sending (${reason}), retrying next poll while the prompt cache is warm`);
  }

  // paneKey → status from the previous tick. Drives the limited-transition
  // alert: when a pane runs out of quota it just goes SILENT — the human
  // discovered ai:4's stall by accident (2026-07-10). One alert per entry
  // into "limited", re-armed when the pane leaves the state.
  const prevStatus = new Map();
  // This map lives in memory, so every bridge restart used to re-announce
  // every already-limited pane: 14 quota-dead Codex panes meant 14 Discord
  // messages per restart, and four restarts during one release evening buried
  // the channels in a stall the human had already been told about twice. The
  // ledger has recorded each `limited` entry all along; nothing read it back.
  seedLimitedFromLedger(prevStatus);

  async function alertOnLimited(agentName, paneIdx, paneKey, status,
                                { limitBannerVisible = false, limitResetAt = null, autoResume = false } = {}) {
    const prev = prevStatus.get(paneKey);
    prevStatus.set(paneKey, nextLimitedMemory(prev, status, { limitBannerVisible }));
    // A bridge that starts while a pane is already limited must still alert;
    // suppressing prev===undefined made quota stalls invisible after reboot.
    if (!enteredLimited(prev, status)) return;

    log(`${paneKey} hit its quota/limit (was: ${prev})`);
    try {
      appendEvent({
        ts: new Date().toISOString(),
        event: "limited",
        session: agentName,
        pane: Number(paneIdx) || 0,
        detail: `quota/limit hit (was: ${prev})`,
      });
    } catch (err) { log(`limited ledger row failed: ${err.message}`); }

    const notice = formatLimitedAlert({ paneKey, resetAt: limitResetAt, autoResume,
      logCommand: `amux log ${agentName} -p ${paneIdx} --tmux` });
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (channelId && discord) {
      await discord.send(channelId, notice.discord)
        .catch((err) => log(`limited warning send failed for ${paneKey}: ${err.message}`));
    }
    notifyUser(notice.push)
      .catch?.((err) => log(`limited push failed: ${err.message}`));
  }

  async function postCompactFailed(agentName, paneIdx, paneKey, reason) {
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) return;
    await discord.send(channelId, formatCompactFailedMessage(paneKey, reason))
      .catch((err) => log(`compact-failed notice send failed for ${paneKey}: ${err.message}`));
  }

  async function postCompactHeld(agentName, paneIdx, paneKey, reason, { lastActivityMs, contextTokens }) {
    if (heldNotices.get(paneKey) === lastActivityMs) return;
    heldNotices.set(paneKey, lastActivityMs);
    log(`${paneKey}: compact held (${reason})`);
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) return;
    await discord.send(channelId, formatCompactHeldMessage(paneKey, reason, contextTokens, lastActivityMs + config.warmCacheMs))
      .catch((err) => log(`compact-held notice send failed for ${paneKey}: ${err.message}`));
  }

  async function postCompactPostponed(agentName, paneIdx, paneKey, reason) {
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) return;
    await discord.send(channelId, formatCompactPostponedMessage(paneKey, reason))
      .catch((err) => log(`compact-postponed notice send failed for ${paneKey}: ${err.message}`));
  }

  async function postWarning(agentName, paneIdx, paneKey, contextTokens) {
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) {
      log(`no discord channel for ${paneKey}, warning suppressed (will still fire at grace end)`);
      return;
    }
    try {
      await discord.send(channelId, formatWarningMessage(paneKey, contextTokens, config.graceMs));
      log(`warned ${paneKey} at ${contextTokens} tokens`);
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
      // The native runtime owns its exact token counters, idle clock and
      // compact RPC. Running the terminal heuristic as a second owner would
      // race or double-compact the same session.
      if (a.backend === "native") continue;
      const panes = Array.isArray(a.panes) ? a.panes : [];
      for (let i = 0; i < panes.length; i++) {
        const paneKey = `${a.name}:${i}`;
        if (compacting.has(paneKey)) continue;
        // Exact compact receipts currently exist for these two engines only.
        // Unsupported engines cannot spend paid attempts on an unverified loop.
        if (!["claude", "codex"].includes(paneDialect(a, i))) continue;
        // A shell may retain old context/quota text. No warning or paid
        // maintenance is eligible without a currently running engine.
        if (typeof agent.paneProcessState !== "function" || (await agent.paneProcessState(a.name, i).catch(() => null))?.running !== true) {
          warnings.delete(paneKey);
          compactFloors.delete(paneKey);
          continue;
        }

        const { status, contextPercent, contextTokens, contextSession, paneInMode, paneHeight, lastActivityMs,
                limitBannerVisible, limitResetAt, autoResume } = await inspect(a, i);

        if (contextSession && contextSessions.has(paneKey) && contextSessions.get(paneKey) !== contextSession) {
          warnings.delete(paneKey);
          compactFloors.delete(paneKey);
          attemptedActivity.delete(paneKey);
        }
        if (contextSession) contextSessions.set(paneKey, contextSession);

        // Quota-silence watch runs for EVERY pane (the classic producer is
        // codex, which the compact logic below deliberately skips).
        await alertOnLimited(a.name, i, paneKey, status, { limitBannerVisible, limitResetAt, autoResume });

        if (!config.codexEnabled && paneDialect(a, i) === "codex") {
          if (warnings.has(paneKey) || compactFloors.has(paneKey) || lastWarnPostAt.has(paneKey)) {
            warnings.delete(paneKey);
            compactFloors.delete(paneKey);
            lastWarnPostAt.delete(paneKey);
          }
          continue;
        }
        // Too small to read reliably — skip rather than act on redraw-soup.
        if (paneHeight != null && paneHeight < MIN_PANE_HEIGHT) {
          if (warnings.has(paneKey) || compactFloors.has(paneKey)) {
            warnings.delete(paneKey);
            compactFloors.delete(paneKey);
          }
          continue;
        }

        if (contextMaintenance && !contextMaintenance.canAttempt(a.name, i, contextSession)) {
          warnings.delete(paneKey);
          continue;
        }
        if (!contextMaintenance && attemptedActivity.has(paneKey) && attemptedActivity.get(paneKey) === lastActivityMs) continue;
        const decision = decideAutoCompactAction({
          paneKey,
          status,
          contextPercent,
          contextTokens,
          paneInMode,
          lastActivityMs,
          warnings,
          compactFloors,
          config,
          now,
        });
        const held = compactHeldReason({ status, paneInMode, contextTokens, lastActivityMs, config, now });
        if (held) await postCompactHeld(a.name, i, paneKey, held, { lastActivityMs, contextTokens });

        if (decision.action === "warn") {
          warnings.set(paneKey, { warned_at: now, sessionId: contextSession });
          // Rate-limit the Discord post (not the state machine): a status-
          // flickering pane re-enters "warn" every poll, which would spam the
          // channel. Post at most once per warnCooldownMs per pane.
          const lastPost = lastWarnPostAt.get(paneKey);
          const cooldown = config.warnCooldownMs ?? 0;
          if (lastPost == null || now - lastPost >= cooldown) {
            lastWarnPostAt.set(paneKey, now);
            await postWarning(a.name, i, paneKey, contextTokens);
          }
        } else if (decision.action === "compact") {
          const warning = warnings.get(paneKey);
          warnings.delete(paneKey);
          // Record the level we fired at BEFORE the compact runs. Next tick
          // (after the in-flight lock clears) compares against it: if context
          // didn't drop below this, the compact was a no-op and decide returns
          // "suppress" instead of firing again.
          compactFloors.set(paneKey, contextTokens);
          attemptedActivity.set(paneKey, lastActivityMs);
          const refusal = await fireCompact(a.name, i, paneKey, contextPercent, paneDialect(a, i));
          if (refusal) keepWarningForRetry(paneKey, warning, refusal);
          if (refusal && refusalNeedsHeldNotice(lastActivityMs, now, config)) {
            await postCompactHeld(a.name, i, paneKey, `the compact was refused: ${refusal}`, { lastActivityMs, contextTokens });
          }
        } else if (decision.action === "postpone") {
          warnings.delete(paneKey);
          // Quiet until new work or a lower context clears the floor; the next
          // message's cold-context admission owns the compact from here.
          compactFloors.set(paneKey, contextTokens);
          log(`postponed ${paneKey} (${decision.reason})`);
          await postCompactPostponed(a.name, i, paneKey, decision.reason);
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
    log(`enabled | >${config.maxTokens} tokens grace=${Math.round(config.graceMs / 1000)}s poll=${Math.round(config.pollMs / 1000)}s min-idle=${Math.round(config.minIdleMs / 1000)}s`);
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
