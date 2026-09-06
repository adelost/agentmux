// Bridge-side poll loop that drives decideAutoCompactAction for every
// configured pane, fires Discord warnings, and sends /compact when the
// grace window elapses. Keeps just enough state (warnings + in-flight
// compact lock) to avoid double-firing. Pure decision logic lives in
// core/auto-compact.mjs; this file is the I/O integration layer.

import {
  decideAutoCompactAction,
  formatWarningMessage,
  formatCompactedMessage,
} from "../core/auto-compact.mjs";
import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { appendEvent, readEvents } from "../core/events.mjs";
import { notifyUser } from "../cli/send-notify.mjs";
import { getContextFromPane, getContextPercent } from "../core/context.mjs";
import { detectPaneStatus, LIMIT_BANNER } from "../cli/format.mjs";
import { latestPaneStatesCached, mergeStatus } from "../core/events.mjs";
import { sendSlashVerified } from "../core/delivery.mjs";
import { panePathFor } from "../core/jsonl-reader.mjs";
import { latestConversationActivityMs } from "../core/pane-activity.mjs";
import { compactReceiptIsAuthoritative } from "../core/dialects.mjs";

// Panes that have warnings pending (paneKey → { warned_at: ms }).
// Panes currently mid-compact (paneKey string).
// Both maps are in-memory — warnings are cheap to re-derive after a
// bridge restart (next poll re-warns if still over threshold).

export function enteredLimited(prev, status) {
  return status === "limited" && prev !== "limited";
}

/**
 * WHAT: Decides what a pane's remembered status becomes after one observation.
 * WHY: `limited` is scraped from a banner in the pane tail (cli/format.mjs:65),
 *      and that banner scrolls out whenever anything else prints — a delivery,
 *      a keystroke, a redraw. The absence of the banner is therefore NOT
 *      evidence that the quota lifted. Overwriting the memory with that absence
 *      manufactures a fresh "entered limited" edge the next time the banner
 *      re-prints, which is why one quota-dead pane re-announced itself roughly
 *      hourly all day: every delivery into it produced one flap.
 *      So `limited` is a latch. Only a pane demonstrably RUNNING clears it;
 *      idle and unknown are absence of evidence, not evidence of recovery.
 *
 *      "Running" cannot be a bare scraped `working` either, and that was the
 *      hole this latch still had. detectPaneStatus DELIBERATELY lets a live
 *      spinner footer beat banner residue, because after a reset the pane really
 *      has resumed while the old banner is still on screen (test/format-status
 *      pins that, and it is right for the compaction decision). But a delivery
 *      into a still-dead pane paints the same footer over a banner that has NOT
 *      expired, so the alert path read the flap as recovery and re-announced the
 *      stall on the next poll. Measured 2026-08-04 on skydive:3, a codex pane
 *      quota-dead until 9 Aug: 427 deliveries, 8 identical alerts to the human,
 *      five of them 60-66s after a delivery burst — one poll interval exactly.
 *
 *      So the two consumers get the standard each needs. Compaction keeps the
 *      scraped status. The latch additionally requires the banner to be GONE:
 *      a visible quota banner is positive evidence the stall persists, and it
 *      outranks a footer that merely proves something was painted.
 */
export const clearsLimitedLatch = (status, { limitBannerVisible = false } = {}) =>
  status === "working" && !limitBannerVisible;

export function nextLimitedMemory(prev, status, options = {}) {
  if (status === "limited") return "limited";
  if (prev === "limited" && !clearsLimitedLatch(status, options)) return "limited";
  return status;
}

/**
 * Events that prove a pane actually RAN a turn, and therefore that a recorded
 * quota stall is over. `delivery_queue` and `notification` say only that
 * something was addressed TO the pane — a quota-dead pane collects those
 * exactly as a live one does, so they prove nothing about whether it can run.
 * They are also the ledger's loudest rows (7158 of 8000+ when this was written),
 * which is why keying on "the newest row of any kind" silently stopped working.
 */
const TURN_PROVING_EVENTS = new Set(["prompt", "stop", "session_start"]);

/**
 * WHAT: Rebuilds "which panes were already limited" from the durable ledger.
 * WHY: The alert fires on a TRANSITION into limited, but the map holding the
 *      previous state is in memory. A restart therefore looked like every
 *      quota-dead pane had just this moment run out.
 * A pane stays seeded as limited until a row that PROVES it ran again arrives
 * after the stall. Same rule as the runtime latch above: only positive evidence
 * of a turn clears a quota stall; traffic addressed to a silent pane is not it.
 */
export function seedLimitedFromLedger(prevStatus, {
  readEventsFn = readEvents, since = null,
} = {}) {
  const limitedPerPane = new Map();
  try {
    for (const evt of readEventsFn({ since })) {
      if (!evt?.session) continue;
      const paneKey = `${evt.session}:${Number(evt.pane) || 0}`;
      if (evt.event === "limited") limitedPerPane.set(paneKey, true);
      else if (TURN_PROVING_EVENTS.has(evt.event)) limitedPerPane.set(paneKey, false);
    }
  } catch { return prevStatus; }
  for (const [paneKey, stillLimited] of limitedPerPane) {
    if (stillLimited) prevStatus.set(paneKey, "limited");
  }
  return prevStatus;
}

export function createAutoCompact({
  agent,
  deliveryBroker = null,
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
  const contextSessions = new Map();
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
    return { status, contextPercent, contextSession: ctxInfo?.sessionId ?? null, paneInMode, paneHeight, lastActivityMs,
             limitBannerVisible };
  }

  async function fireCompact(agentName, paneIdx, paneKey, contextPercent, dialect) {
    if (compacting.has(paneKey)) return;
    compacting.add(paneKey);
    try {
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
      // shows old context% pre-summary.
      setTimeout(() => compacting.delete(paneKey), config.compactLockMs ?? 120_000);
    }
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
                                { limitBannerVisible = false } = {}) {
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

    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (channelId && discord) {
      await discord.send(channelId,
        `🚫 **${paneKey} har slagit i kvot/limit — arbetet står stilla.** Återställningstiden syns i panelen (\`amux log ${agentName} -p ${paneIdx} --tmux\`). Knuffa igång den när kvoten är tillbaka.`)
        .catch((err) => log(`limited warning send failed for ${paneKey}: ${err.message}`));
    }
    notifyUser(`🚫 ${paneKey} slut på kvot — står stilla tills du knuffar`)
      .catch?.((err) => log(`limited push failed: ${err.message}`));
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
      // The native runtime owns its exact token counters, idle clock and
      // compact RPC. Running the terminal heuristic as a second owner would
      // race or double-compact the same session.
      if (a.backend === "native") continue;
      const panes = Array.isArray(a.panes) ? a.panes : [];
      for (let i = 0; i < panes.length; i++) {
        const paneKey = `${a.name}:${i}`;
        if (compacting.has(paneKey)) continue;

        const { status, contextPercent, contextSession, paneInMode, paneHeight, lastActivityMs,
                limitBannerVisible } = await inspect(a, i);

        if (contextSession && contextSessions.has(paneKey) && contextSessions.get(paneKey) !== contextSession) {
          warnings.delete(paneKey);
          compactFloors.delete(paneKey);
        }
        if (contextSession) contextSessions.set(paneKey, contextSession);

        // Quota-silence watch runs for EVERY pane (the classic producer is
        // codex, which the compact logic below deliberately skips).
        await alertOnLimited(a.name, i, paneKey, status, { limitBannerVisible });

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
          warnings.set(paneKey, { warned_at: now, sessionId: contextSession });
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
          await fireCompact(a.name, i, paneKey, contextPercent, paneDialect(a, i));
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
