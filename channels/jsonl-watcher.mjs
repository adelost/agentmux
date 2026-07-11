// jsonl-watcher: event-driven mirror of agent replies → bound Discord channels.
//
// Replaces the old fan of ad-hoc forwarders (handlers.streamResponse,
// drift-guard.forwardReplyAsync, resume-hint forwardHintReplyAsync,
// mirror-loop). One watcher per claude/codex pane, fs.watch on its
// project dir, polling fallback for WSL 9p reliability, persistent
// state for restart-resume and dedupe.
//
// Lifecycle of a reply:
//   1. agent writes a turn to ~/.claude/projects/<encoded-pane-dir>/*.jsonl
//   2. fs.watch fires (or 15s poll catches it on slow filesystems)
//   3. watcher reads the latest jsonl, groups events into turns
//   4. for each turn that:
//        - has timestamp > last-posted-ts for this channel
//        - has isComplete = true (terminal stop_reason hit)
//        - or endTimestamp older than COMPLETION_GRACE_MS (failsafe)
//      → render text, split into Discord-sized chunks, post with pacing,
//        attach image markers if present, append context footer, run TTS,
//        update last-posted-ts in persistent state
//   5. dedupe: per-channel last-posted-ts written to appState. Survives
//      bridge restart. Other forwarders update channel_last_mirror_ts via
//      stampChannelMirror, which we ALSO honour as a "covered" signal.
//
// Stops the user-visible problems we kept hitting:
//   - drift-guard / resume-hint forwarders timing out → reply lost
//   - bridge restart mid-streamResponse → reply lost
//   - voice-PWA outbound never had a Discord mirror at all
//   - matcher mismatches on ax-meta / TTS / voice prefixes
//   - tmux fallback shipping pane chrome to Discord
//
// All these scenarios converge on "agent wrote turn to jsonl but Discord
// didn't see it". Watcher reads jsonl directly so it's by definition
// covering all of them.

import { watch, statSync, existsSync } from "fs";
import { join } from "path";
import { splitMessage, extractImageMarkers, validateImagePath, chunkAttachments } from "../lib.mjs";
import { loadConfig, findChannelForPane, channelForPane } from "../cli/config.mjs";
import { paneDir } from "../agent.mjs";
import { claudeProjectDir } from "../core/claude-paths.mjs";
import { readLastTurns, latestJsonlMtime, latestJsonlInfo } from "../core/jsonl-reader.mjs";
import { readLastTurnsCodex, latestCodexJsonlMtime, latestCodexJsonlInfo } from "../core/codex-jsonl-reader.mjs";
import { getContextFromPane, shortModelName } from "../core/context.mjs";
import { isHarnessPlaceholder } from "../core/reply-forwarder.mjs";
import { applyPostFailure, applyPostSuccess, planPaneMirrorStep, planStartupAudit, itemKey } from "../core/watcher-engine.mjs";
import {
  classifyModelChange, changeMessage, stopBrief, shouldStopPane, label as modelLabel,
  decideRecovery, resumeBrief, recoveryMessage, interruptUntilIdle,
} from "../core/model-watch.mjs";
import { driveCodexModelPicker } from "../core/codex-model-picker.mjs";
import { sendSlashVerified } from "../core/delivery.mjs";
import { parkPane, unparkPane } from "../core/pane-park.mjs";
import { appendEvent } from "../core/events.mjs";
import { notifyUser } from "../cli/send-notify.mjs";
import { createPaneQueue } from "../core/pane-queue.mjs";

const DEFAULT_POLL_MS = 15_000;
// Typing-indicator is event-driven via fs.watch (every jsonl write fires
// sendTyping with throttle below). This polling cadence is the fallback
// for environments where fs.watch silently drops events (WSL 9p mounts,
// some network filesystems). Every 8s, sweep all panes and refresh the
// bubble for any pane whose jsonl mtime is fresh.
const DEFAULT_TYPING_POLL_MS = 8_000;
// Throttle per-channel typing-bubble refresh. Discord auto-clears the
// bubble ~10s after the last sendTyping call, so refreshing every 5s
// keeps it continuously lit during long streams without hammering the
// API on every assistant-delta jsonl write (which can be 10×/sec).
const TYPING_THROTTLE_MS = 5_000;
// jsonl write within this window = pane is active. Polling fallback
// uses this to refresh typing when fs.watch missed events. Tuned to
// bridge normal thinking-pauses between assistant deltas without
// keeping the bubble on for stale residue.
const TYPING_FRESHNESS_MS = 15_000;
// A turn whose endTimestamp is older than this counts as "done writing"
// even if its stop_reason wasn't terminal (compacted sessions, crashed
// claude). Belt-and-suspenders so we never sit on a stale partial turn.
const COMPLETION_GRACE_MS = 5_000;
// Cap turns considered per pane per tick. Watcher posts the latest few
// missed turns at restart, not the entire history.
const TURN_LOOKBACK = 20;
const WATCHER_TAIL_BYTES = 4 * 1024 * 1024;
// Startup is the one chance to reconcile output written while the bridge was
// down. Browser screenshots can add several MB of base64 tool output per line,
// so the normal 4MB hot-path window is too small for this bounded audit.
const STARTUP_AUDIT_TAIL_BYTES = 16 * 1024 * 1024;
const MAX_POST_ACTIONS = 3;
const RETRY_BACKOFF_MS = 30_000;
const MAX_CONCURRENT_PANES = 4;

const STATE_KEY_LAST_POSTED = "watcher_last_posted_ts";
// Posted-item dedupe keyed on stable content-addressed ids (see watcher-engine
// itemKey / jsonl-reader itemIdFor). Replaces the old positional
// watcher_posted_item_counts, whose turnStartMs+index keys drifted under the
// sliding tail window and dropped final texts. Migration is graceful: the new
// key starts empty; the separate last-posted cursor still gates by timestamp,
// so at most the in-flight turn re-posts once on first deploy.
const STATE_KEY_POSTED_IDS = "watcher_posted_item_ids";
const STATE_KEY_RETRY_UNTIL = "watcher_retry_until_ts";
const STATE_KEY_COMPACTION_IDS = "watcher_compaction_ids";
const STATE_KEY_CUSTOM_TOOLS_SEEDED = "watcher_custom_tools_seeded";

/**
 * WHAT: Routes completed Claude and Codex JSONL items to their bound channels.
 * WHY: Keeps response forwarding restart-safe and independent of terminal scrollback.
 */
export function createJsonlWatcher({
  agent,
  agentsYamlPath,
  discord,
  state,
  recorder = null,
  tts = null,
  pollMs = DEFAULT_POLL_MS,
  typingPollMs = DEFAULT_TYPING_POLL_MS,
  postPrefix = "",
  log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} watcher | ${msg}`),
} = {}) {
  if (!agent) throw new Error("watcher: agent required");
  if (!agentsYamlPath) throw new Error("watcher: agentsYamlPath required");
  if (!discord) throw new Error("watcher: discord required");
  if (!state) throw new Error("watcher: state store required");

  /** active fs.watch handles per pane key (`name:idx`). */
  const fsWatchers = new Map();
  /** per-channel last-sendTyping ms, throttled via TYPING_THROTTLE_MS. */
  const lastTypingAt = new Map();
  /**
   * Last parsed jsonl identity per pane.
   *
   * WHAT: path+mtime+size stamp plus the next grace deadline, all in memory.
   * WHY: Safety-net polling should be cheap when a pane's append-only jsonl
   *      did not change. The grace deadline keeps incomplete turns from being
   *      skipped forever once they become old enough to mirror.
   */
  const readSnapshots = new Map();
  // Panes audited since THIS bridge started — the startup self-heal runs once
  // per pane, then the normal cursor engine owns the stream again.
  const auditedPanes = new Set();
  const metricsEnabled = process.env.AMUX_WATCHER_METRICS === "1";
  let pollTimer = null;
  let typingTimer = null;
  let stopped = false;

  const paneKey = (name, idx) => `${name}:${idx}`;
  const queue = createPaneQueue({
    worker: ({ name, idx, agentDir, sharedConfig }) => processPane(name, idx, agentDir, sharedConfig),
    maxConcurrency: MAX_CONCURRENT_PANES,
    backoffMs: RETRY_BACKOFF_MS,
    log,
  });

  // Discord typing-indicator. Called by both fs.watch (event-driven, fires
  // on every jsonl write) and typingTick (polling fallback for WSL 9p).
  // Throttle keeps API calls sane during streaming bursts.
  function maybeSendTyping(name, idx, sharedConfig = null) {
    if (typeof discord.sendTyping !== "function") return;
    const channelId = sharedConfig
      ? channelForPane(sharedConfig, name, idx)
      : findChannelForPane(agentsYamlPath, name, idx);
    if (!channelId) return;
    const now = Date.now();
    const last = lastTypingAt.get(channelId) || 0;
    if (now - last < TYPING_THROTTLE_MS) return;
    lastTypingAt.set(channelId, now);
    discord.sendTyping(channelId).catch(() => { /* cosmetic, swallow */ });
  }

  // --- state helpers --------------------------------------------------------

  function lastPostedMs(channelId) {
    const map = state.get(STATE_KEY_LAST_POSTED, {}) || {};
    const v = map[channelId];
    if (typeof v !== "number") return null;
    return Number.isFinite(v) ? v : null;
  }

  function setLastPostedMs(channelId, ms) {
    const map = state.get(STATE_KEY_LAST_POSTED, {}) || {};
    map[channelId] = ms;
    state.set(STATE_KEY_LAST_POSTED, map);
  }

  function postedItemIds(channelId) {
    const map = state.get(STATE_KEY_POSTED_IDS, {}) || {};
    const v = map[channelId];
    return Array.isArray(v) ? [...v] : [];
  }

  function setPostedItemIds(channelId, ids) {
    const map = state.get(STATE_KEY_POSTED_IDS, {}) || {};
    map[channelId] = Array.isArray(ids) ? ids : [];
    state.set(STATE_KEY_POSTED_IDS, map);
  }

  function retryUntilMs(channelId) {
    const map = state.get(STATE_KEY_RETRY_UNTIL, {}) || {};
    const v = map[channelId];
    return Number.isFinite(v) ? v : null;
  }

  function setRetryUntilMs(channelId, ms) {
    const map = state.get(STATE_KEY_RETRY_UNTIL, {}) || {};
    if (Number.isFinite(ms) && ms > Date.now()) map[channelId] = ms;
    else delete map[channelId];
    state.set(STATE_KEY_RETRY_UNTIL, map);
  }

  const STATE_KEY_LAST_MODEL = "watcher_last_model";
  const STATE_KEY_RECOVERY = "watcher_recovery";
  const recoveryEnabled = process.env.AMUX_MODEL_RECOVERY !== "false";

  /**
   * One loop-guarded switch-back after a park. The attempt is recorded
   * BEFORE any keystroke (crash-safety), and decideRecovery's cooldown
   * makes a flap (quota bounce re-downgrading right after a "successful"
   * switch) die after a single attempt instead of looping. Restored panes
   * are unparked and woken with the re-verify brief; failures stay parked
   * for the human, exactly like before auto-recovery existed.
   */
  async function attemptModelRecovery({ name, idx, paneName, channelId, prev, config }) {
    const key = paneKey(name, idx);
    const attempts = state.get(STATE_KEY_RECOVERY, {}) || {};
    const decision = decideRecovery({ lastAttemptMs: attempts[key]?.attemptedAtMs, enabled: recoveryEnabled });
    if (!decision.attempt) {
      log(`${paneName} recovery skipped: ${decision.reason}`);
      return { attempted: false, restored: false, detail: decision.reason };
    }
    attempts[key] = { attemptedAtMs: Date.now(), target: modelLabel(prev) };
    state.set(STATE_KEY_RECOVERY, attempts);

    const paneCmd = config?.[name]?.panes?.[idx]?.cmd || "";
    let restored = false;
    let detail = "";
    try {
      if (/codex/i.test(paneCmd)) {
        const res = await driveCodexModelPicker({
          agent, name, pane: idx, model: prev.model, effort: prev.effort || null, log,
        });
        restored = res.ok;
        detail = res.ok
          ? `${res.model}${res.effort ? ` ${res.effort}` : ""}`
          : `${res.stage}: ${res.error}`;
      } else {
        const sent = await sendSlashVerified(agent, name, idx, `/model ${prev.model}`);
        if (!sent.delivered) {
          detail = "slash delivery failed";
        } else {
          // /model produces no jsonl turn, so verify against the live
          // statusline instead of waiting for a reading that never comes.
          await new Promise((r) => setTimeout(r, 3000));
          const liveCtx = await agent.getContext?.(name, idx).catch(() => null);
          restored = !!liveCtx?.model &&
            String(liveCtx.model).trim().toLowerCase() === String(prev.model).trim().toLowerCase();
          detail = restored ? modelLabel(prev) : `statusline still shows ${liveCtx?.model || "unknown"}`;
        }
      }
    } catch (err) {
      detail = err.message;
    }

    if (restored) {
      try { unparkPane({ session: name, pane: idx, detail: `auto-recovery: ${detail}` }); }
      catch (err) { log(`${paneName} unpark after recovery failed: ${err.message}`); }
      // Sync the last-model map so the recovery itself is not re-classified
      // as yet another change on the next reading.
      const models = state.get(STATE_KEY_LAST_MODEL, {}) || {};
      models[key] = { model: prev.model, effort: prev.effort ?? null };
      state.set(STATE_KEY_LAST_MODEL, models);
      try { await agent.sendOnly(name, resumeBrief(modelLabel(prev)), idx); }
      catch (err) { log(`${paneName} resume brief failed: ${err.message}`); }
    }
    log(`${paneName} recovery ${restored ? "ok" : "failed"}: ${detail}`);
    await discord.send(channelId, recoveryMessage(paneName, restored, detail))
      .catch((err) => log(`recovery channel line failed for ${paneName}: ${err.message}`));
    return { attempted: true, restored, detail };
  }

  /**
   * Model-watch hook: runs where the footer ctx is computed (zero extra I/O).
   * First sighting only records; a change warns in-channel + ledger, and a
   * DOWNGRADE additionally pushes mobile and briefs the pane to re-verify
   * its plan (see core/model-watch.mjs for the policy rationale).
   */
  async function watchModelChange({ name, idx, channelId, ctx, config = null }) {
    if (!ctx?.model) return;
    // Head-sourced readings are the session's ORIGINAL model — potentially
    // stale, good enough for a display label but NOT evidence of a switch.
    // Acting on one parked two healthy panes (false downgrade, 2026-07-10).
    if (ctx.modelSource && ctx.modelSource !== "turn") return;
    const key = paneKey(name, idx);
    const map = state.get(STATE_KEY_LAST_MODEL, {}) || {};
    const prev = map[key];
    const next = { model: ctx.model, effort: ctx.effort ?? null };
    map[key] = next;
    state.set(STATE_KEY_LAST_MODEL, map);
    if (!prev) return;

    const change = classifyModelChange(prev, next);
    if (!change) return;

    const paneName = `${name}:${idx}`;
    log(`${paneName} model change: ${change.from} → ${change.to} (${change.direction})`);
    try {
      appendEvent({
        ts: new Date().toISOString(),
        event: "model_change",
        session: name,
        pane: Number(idx) || 0,
        direction: change.direction,
        detail: `${change.from} → ${change.to}`,
      });
    } catch (err) { log(`model-change ledger row failed: ${err.message}`); }

    await discord.send(channelId, changeMessage(paneName, change, ctx.percent))
      .catch((err) => log(`model-change warning failed for ${paneName}: ${err.message}`));

    if (!shouldStopPane(change)) {
      // A model-kind recovery lifts the park so briefs flow again. The
      // ledger row is idempotent (latest wins), so no read-check needed.
      if (change.direction === "upgrade" && change.kind === "model") {
        try {
          unparkPane({ session: name, pane: idx, detail: `${change.from} → ${change.to}` });
          log(`${paneName} unparked (model restored: ${change.to})`);
        } catch (err) { log(`unpark failed for ${paneName}: ${err.message}`); }
      }
      return;
    }
    notifyUser(`🔀 ${paneName} nedgraderad och STOPPAD: ${change.from} → ${change.to} — knuffa när läget är rätt`)
      .catch?.((err) => log(`model-change push failed: ${err.message}`));
    // Stop the harm first: a mid-turn pane keeps building on the weaker
    // model until interrupted. Then park it. The
    // ledger park makes the state visible to every send path (the api:3
    // incident: briefs woke a parked pane, 45 min of work on luna low).
    try {
      parkPane({ session: name, pane: idx, detail: `${change.from} → ${change.to}` });
    } catch (err) { log(`park ledger row failed for ${paneName}: ${err.message}`); }
    const interruption = await interruptUntilIdle({
      isBusy: () => agent.isBusy(name, idx),
      sendEscape: () => agent.sendEscape(name, idx),
    });
    if (!interruption.stopped) {
      log(`model-change stop failed for ${paneName}: ${interruption.detail}`);
      await discord.send(channelId,
        `🚨 **${paneName}: stopp kunde inte verifieras** (${interruption.detail}). ` +
        "Panelen är fortfarande parkerad och tar inga nya briefs; avbryt manuellt med `amux esc`.")
        .catch((err) => log(`model-change stop failure line failed for ${paneName}: ${err.message}`));
      return;
    }
    log(`${paneName} stopped after ${interruption.escapes} Escape attempt(s)`);

    // Recover while the pane is neutral. The old order sent stopBrief first;
    // that started a new turn, so the codex picker correctly refused the busy
    // pane and auto-recovery defeated itself. Only brief the downgraded model
    // when recovery was skipped or failed.
    const recovery = await attemptModelRecovery({ name, idx, paneName, channelId, prev, config });
    if (!recovery.restored) {
      try {
        await agent.sendOnly(name, stopBrief(change), idx);
      } catch (err) {
        log(`model-change stop brief failed for ${paneName}: ${err.message}`);
      }
    }
  }

  function commitEngineState(channelId, nextState) {
    if (!nextState) return;
    if (Number.isFinite(nextState.lastPostedMs)) setLastPostedMs(channelId, nextState.lastPostedMs);
    setPostedItemIds(channelId, nextState.postedItemIds || []);
    setRetryUntilMs(channelId, nextState.retryUntilMs);
  }

  async function postCompactionNotice(name, idx, channelId, events = []) {
    if (!events.length) return;
    const stateByChannel = state.get(STATE_KEY_COMPACTION_IDS, {}) || {};
    const visibleIds = events.map((event) => event.id).filter(Boolean);

    // Migration seed: an upgrade must not announce every historical compact
    // still visible in the startup tail. Once seeded, any unseen id means the
    // event happened while this bridge generation was running or offline.
    if (!Object.hasOwn(stateByChannel, channelId)) {
      stateByChannel[channelId] = visibleIds.slice(-100);
      state.set(STATE_KEY_COMPACTION_IDS, stateByChannel);
      return;
    }

    const seen = new Set(stateByChannel[channelId] || []);
    const unseen = events.filter((event) => event.id && !seen.has(event.id));
    if (!unseen.length) return;

    const count = unseen.length;
    const text = count === 1
      ? `Context compacted for **${name}:${idx}**. Work continues from the summary.`
      : `Context compacted ${count} times for **${name}:${idx}** while the bridge was offline. Work continues from the latest summary.`;
    try {
      await discord.send(channelId, text);
      stateByChannel[channelId] = [...seen, ...visibleIds].slice(-100);
      state.set(STATE_KEY_COMPACTION_IDS, stateByChannel);
      log(`${name}:${idx} → ${channelId} (compaction notice x${count})`);
    } catch (err) {
      log(`compaction notice failed for ${name}:${idx}: ${err.message}`);
    }
  }

  function seedCustomToolMigration(channelId, turns = []) {
    const seeded = state.get(STATE_KEY_CUSTOM_TOOLS_SEEDED, {}) || {};
    if (seeded[channelId]) return;

    // custom_tool_call support was added after stable item-id dedupe shipped.
    // On the first upgraded read, those historical ids look "new" even though
    // they may be hours old. Bank all currently visible custom calls once so
    // restart audit cannot flood Discord; subsequent calls flow normally.
    const historicalIds = turns.flatMap((turn) => (turn.items || []))
      .filter((item) => item.source === "custom" && item.id)
      .map((item) => item.id);
    if (historicalIds.length) {
      setPostedItemIds(channelId, [...new Set([...postedItemIds(channelId), ...historicalIds])].slice(-1000));
    }
    seeded[channelId] = true;
    state.set(STATE_KEY_CUSTOM_TOOLS_SEEDED, seeded);
  }

  // --- rendering -----------------------------------------------------------

  function renderTurn(turn) {
    // Tool calls render as compact semantic labels (`Run ...`, `Edit ...`).
    // Provider wrapper names stay internal so Claude and Codex look alike.
    const items = turn.items || [];
    const hasNarrative = items.some((it) => it.type === "text" && (it.content || "").trim());
    const rawText = items
      // Codex emits write_stdin/wait calls for every background-process poll.
      // The readers classify both legacy and current envelopes semantically.
      .filter((it) => it.kind !== "wait")
      // Cross-agent sends have a stronger, delivery-verified owner in
      // cli/tmux.mjs: target gets the full brief and sender gets an immediate
      // `amux ... → delivered` receipt. Do not repeat the invocation later.
      .filter((it) => it.kind !== "inter-agent-send")
      .map((it) => (it.type === "tool" ? `\`${it.content}\`` : it.content))
      .join("\n\n")
      .trim();
    const { text: cleanedText, paths: imagePaths } = extractImageMarkers(rawText);
    const validFiles = [];
    const failedMarkers = [];
    for (const p of imagePaths) {
      const result = validateImagePath(p, statSync);
      if (result.ok) validFiles.push(result.path);
      else failedMarkers.push(`⚠️ image skipped: \`${p}\` (${result.error})`);
    }
    const fullText = [cleanedText, ...failedMarkers].filter(Boolean).join("\n\n");
    return { fullText, validFiles, hasNarrative };
  }

  async function postTurn({ name, idx, channelId, turn, config = null }) {
    const { fullText, validFiles, hasNarrative } = renderTurn(turn);
    if (!fullText && validFiles.length === 0) return { ok: true };
    // "No response requested." is Claude Code answering a harness-injected
    // notification (dead background task, resume bookkeeping) — not the
    // agent talking. Mirroring it reads as a refusal to answer; the real
    // reply arrives as its own turn right after. Skip text AND footer.
    if (isHarnessPlaceholder(fullText) && validFiles.length === 0) return { ok: true };

    const body = postPrefix && fullText ? `${postPrefix}${fullText}` : fullText || "(no text)";
    const chunks = splitMessage(body);
    // Discord hard-caps 10 attachments/message; 11+ screenshots on the
    // first chunk used to 400 the whole message (text AND images lost).
    // Group 0 rides the first text chunk, the rest go as file-only
    // follow-ups below, all under the same pacing.
    const fileGroups = chunkAttachments(validFiles);
    // Pacing: Discord rate limit drops chunks in tight bursts.
    const paceUnits = chunks.length + Math.max(0, fileGroups.length - 1);
    const pacePerChunk = paceUnits >= 2 ? (paceUnits > 3 ? 400 : 250) : 0;
    const pace = () => pacePerChunk > 0 && new Promise((r) => setTimeout(r, pacePerChunk));
    let ok = true;
    for (let i = 0; i < chunks.length; i++) {
      const payload = (i === 0 && fileGroups.length)
        ? { content: chunks[i], files: fileGroups[0] }
        : chunks[i];
      try {
        await discord.send(channelId, payload);
      } catch (err) {
        ok = false;
        log(`chunk ${i + 1}/${chunks.length} failed for ${name}:${idx}: ${err.message}`);
      }
      if (i < chunks.length - 1) await pace();
    }
    for (let g = 1; g < fileGroups.length; g++) {
      await pace();
      try {
        await discord.send(channelId, { files: fileGroups[g] });
      } catch (err) {
        ok = false;
        log(`file group ${g + 1}/${fileGroups.length} failed for ${name}:${idx}: ${err.message}`);
      }
    }
    if (!ok) return { ok: false };

    // Context footer — prefer tmux UI percent so the number matches what
    // auto-compact sees and what Claude Code itself displays. CC's bar is
    // computed against its own effective window (~840k for the 1M beta,
    // not raw 1M), so jsonl-derived percent (697k/1000k = 70%) and
    // UI-derived percent (697k/840k = 84%) diverged. UI is the user-facing
    // metric that actually predicts auto-compact firing — match it.
    // Fall back to jsonl if the pane has no visible token line (idle
    // narrow pane, just-spawned, etc).
    if (hasNarrative || validFiles.length > 0) try {
      // One source of truth: agent.getContext is pane-first (CC's own
      // percent, incl. custom-statusline rows) with jsonl fallback.
      let ctx = null;
      if (agent.getContext) {
        ctx = await agent.getContext(name, idx);
      } else {
        try {
          const cfg = config || loadConfig(agentsYamlPath);
          const entryDir = cfg?.[name]?.dir;
          if (entryDir) {
            const dir = paneDir(entryDir, idx);
            const content = await agent.capturePane(name, idx, 100);
            ctx = getContextFromPane(content, dir);
          }
        } catch { /* fall through to jsonl */ }
        if (!ctx) ctx = agent.getContextPercent?.(name, idx);
      }
      if (ctx) {
        await watchModelChange({ name, idx, channelId, ctx, config })
          .catch((err) => log(`model-watch failed for ${name}:${idx}: ${err.message}`));
        // tokens can be null when percent came from a custom statusline row.
        const suffix = ctx.tokens != null ? ` (${Math.round(ctx.tokens / 1000)}k)` : "";
        const model = shortModelName(ctx.model);
        // Codex carries a reasoning effort next to the model ("gpt-5.6-sol
        // max"); claude has no equivalent, ctx.effort stays undefined there.
        const modelLabel = model ? `${model}${ctx.effort ? ` ${ctx.effort}` : ""}` : null;
        const prefix = modelLabel ? `${modelLabel} · ` : "";
        await discord.send(channelId, `_${prefix}context: ${ctx.percent}%${suffix}_`)
          .catch((err) => log(`context-footer ${name}:${idx}: ${err.message}`));
      }
    } catch (err) {
      log(`context-footer skipped ${name}:${idx}: ${err.message}`);
    }

    // Auto-TTS removed. The watcher used to read every reply aloud, but
    // that meant accidental long technical replies got broadcast to a
    // car listener. Spoken output is now explicit only: the user asks
    // for voice, then the agent may call `amux say "..."`.

    // Recorder (regression replay)
    if (recorder?.enabled && recorder.save) {
      try {
        recorder.save({
          source: "jsonl-watcher",
          agent: name,
          pane: idx,
          turn,
        });
      } catch { /* swallow — recorder is best-effort */ }
    }

    return { ok };
  }

  // --- core check ----------------------------------------------------------

  /**
   * Determine which jsonl reader to use for a pane.
   * Codex panes have cmd containing "codex" in agents.yaml. Anything else
   * (claude, claude-2, …) falls through to the Claude reader. Unknown
   * panes default to Claude — same behavior as before this dispatch.
   */
  function readerFor(config, name, idx) {
    try {
      const cmd = config?.[name]?.panes?.[idx]?.cmd || "";
      if (/codex/i.test(cmd)) {
        return { readTurns: readLastTurnsCodex, latestMtime: latestCodexJsonlMtime, latestInfo: latestCodexJsonlInfo };
      }
    } catch { /* fall through to claude default */ }
    return { readTurns: readLastTurns, latestMtime: latestJsonlMtime, latestInfo: latestJsonlInfo };
  }

  function sameFileStamp(a, b) {
    return !!a && !!b && a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;
  }

  function estimatedReadBytes(info, tailBytes = WATCHER_TAIL_BYTES) {
    if (!info?.size) return 0;
    return Math.min(info.size, tailBytes);
  }

  function metric(msg) {
    if (metricsEnabled) log(`metrics | ${msg}`);
  }

  function turnMs(iso) {
    if (!iso) return NaN;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : NaN;
  }

  function pendingGraceDueAt(turns, channelId, latestMtimeMs) {
    const cursorMs = lastPostedMs(channelId);
    if (!Number.isFinite(cursorMs)) return null;
    const postedSet = new Set(postedItemIds(channelId));
    let dueAt = null;

    for (const turn of turns || []) {
      if (turn?.isComplete) continue;
      const endMs = turnMs(turn?.endTimestamp || turn?.timestamp);
      if (!Number.isFinite(endMs) || endMs <= cursorMs) continue;
      const items = Array.isArray(turn.items) ? turn.items : [];
      if (items.length === 0) continue;

      // Any item whose stable id is not yet in the posted set is still pending.
      const startMs = turnMs(turn.timestamp) || endMs;
      const hasUnposted = items.some((it, idx) => !postedSet.has(itemKey(it, startMs, idx)));
      if (!hasUnposted) continue;

      const baseMs = Math.max(endMs, Number.isFinite(latestMtimeMs) ? latestMtimeMs : 0);
      const candidate = baseMs + COMPLETION_GRACE_MS;
      dueAt = dueAt === null ? candidate : Math.min(dueAt, candidate);
    }

    return dueAt;
  }

  function rememberReadSnapshot(key, info, turns, channelId, latestMtimeMs) {
    if (!info) {
      readSnapshots.delete(key);
      return;
    }
    readSnapshots.set(key, {
      ...info,
      graceDueAtMs: pendingGraceDueAt(turns, channelId, latestMtimeMs),
    });
  }

  async function processPane(name, idx, agentDir, sharedConfig = null) {
    try {
      const config = sharedConfig || loadConfig(agentsYamlPath);
      const channelId = channelForPane(config, name, idx);
      if (!channelId) return;

      const dir = paneDir(agentDir, idx);
      const key = paneKey(name, idx);
      const { readTurns, latestMtime, latestInfo } = readerFor(config, name, idx);
      const now = Date.now();
      const fileInfo = latestInfo(dir);
      const cached = readSnapshots.get(key);
      const retryUntil = retryUntilMs(channelId);
      const retryDue = Number.isFinite(retryUntil) && retryUntil <= now;
      const graceDue = Number.isFinite(cached?.graceDueAtMs) && cached.graceDueAtMs <= now;
      const startupAudit = !auditedPanes.has(key);

      if (sameFileStamp(cached, fileInfo) && !retryDue && !graceDue) {
        metric(`${key} skip unchanged bytes=0 nextGrace=${cached?.graceDueAtMs || "-"}`);
        return { skipped: "unchanged" };
      }

      const readStarted = Date.now();
      // headless: reconstruct a turn even when the tail window begins after its
      // user-prompt marker (the >window-bytes tool_results case) so the final
      // text is never orphaned. truncated: the file is larger than the window,
      // so the leading turn may be head-cut — the engine holds it instead of
      // advancing past it (belt-and-suspenders on top of id-based dedupe).
      const tailBytes = startupAudit ? STARTUP_AUDIT_TAIL_BYTES : WATCHER_TAIL_BYTES;
      const result = readTurns(dir, { limit: TURN_LOOKBACK, tailBytes, headless: true });
      const truncated = Number.isFinite(fileInfo?.size) && fileInfo.size > tailBytes;
      const readMs = Date.now() - readStarted;
      const readBytes = estimatedReadBytes(fileInfo, tailBytes);
      await postCompactionNotice(name, idx, channelId, result?.compactions || []);
      seedCustomToolMigration(channelId, result?.turns || []);
      if (!result?.turns?.length) {
        if (startupAudit) auditedPanes.add(key);
        rememberReadSnapshot(key, fileInfo, [], channelId, fileInfo?.mtimeMs ?? null);
        metric(`${key} read bytes=${readBytes} ms=${readMs} turns=0`);
        return { readBytes, readMs };
      }

      const mtimeMs = fileInfo?.mtimeMs ?? latestMtime(dir);

      // Startup self-heal: post anything a previous bridge completed but never
      // delivered (kill -9 mid-grace loses the item forever once the cursor
      // moves — the lsrc:3 incident, 2026-07-10). Id-dedupe makes re-runs safe.
      if (startupAudit) {
        auditedPanes.add(key);
        const audit = planStartupAudit({
          turns: result.turns,
          postedItemIds: postedItemIds(channelId),
          nowMs: now,
        });
        for (const action of audit.actions) {
          const posted = await postTurn({ name, idx, channelId, turn: action.turn, config });
          if (!posted?.ok) {
            // Cold Discord cache at startup is the common cause — un-mark so
            // the NEXT poll retries the whole audit instead of losing it to
            // the one-per-lifetime gate (observed api:1, first 1.20.61 boot).
            auditedPanes.delete(key);
            log(`${name}:${idx} audit post failed — retrying next poll`);
            break;
          }
          commitEngineState(channelId, applyPostSuccess({
            lastPostedMs: lastPostedMs(channelId),
            postedItemIds: postedItemIds(channelId),
            retryUntilMs: retryUntilMs(channelId),
          }, action));
          log(`${name}:${idx} → ${channelId} (audit: recovered ${action.postedIds.length} missed item(s) from ${new Date(action.endMs).toISOString()})`);
        }
      }

      const planned = planPaneMirrorStep({
        turns: result.turns,
        lastPostedMs: lastPostedMs(channelId),
        postedItemIds: postedItemIds(channelId),
        truncated,
        retryUntilMs: retryUntil,
        nowMs: now,
        latestMtimeMs: mtimeMs,
        completionGraceMs: COMPLETION_GRACE_MS,
        maxPostActions: MAX_POST_ACTIONS,
      });
      commitEngineState(channelId, planned.nextState);
      metric(`${key} read bytes=${readBytes} ms=${readMs} turns=${result.turns.length} actions=${planned.actions.length}`);

      for (const note of planned.notes || []) {
        if (note.type === "seed") {
          log(`seeded ${name}:${idx} → ${channelId} @ ${new Date(note.lastPostedMs).toISOString()}`);
        }
      }

      for (const action of planned.actions) {
        const result = await postTurn({ name, idx, channelId, turn: action.turn, config });
        if (!result?.ok) {
          const nextState = applyPostFailure({
            lastPostedMs: lastPostedMs(channelId),
            postedItemIds: postedItemIds(channelId),
            retryUntilMs: retryUntilMs(channelId),
          }, action, { nowMs: now, retryBackoffMs: RETRY_BACKOFF_MS });
          commitEngineState(channelId, nextState);
          log(`${name}:${idx} → ${channelId} main post failed; retry after ${Math.round(RETRY_BACKOFF_MS / 1000)}s`);
          rememberReadSnapshot(key, fileInfo, result.turns, channelId, mtimeMs);
          return { retryAfterMs: RETRY_BACKOFF_MS };
        }

        const nextState = applyPostSuccess({
          lastPostedMs: lastPostedMs(channelId),
          postedItemIds: postedItemIds(channelId),
          retryUntilMs: retryUntilMs(channelId),
        }, action);
        commitEngineState(channelId, nextState);
        const ageS = Math.round((now - action.endMs) / 1000);
        log(`${name}:${idx} → ${channelId} (${action.reason}, age=${ageS}s, items ${action.postedCount}→${action.totalItems})`);
      }

      rememberReadSnapshot(key, fileInfo, result.turns, channelId, mtimeMs);
      return { readBytes, readMs, actions: planned.actions.length };
    } catch (err) {
      log(`check ${paneKey(name, idx)}: ${err.stack || err.message}`);
    }
  }

  async function checkPane(name, idx, agentDir, sharedConfig = null) {
    return processPane(name, idx, agentDir, sharedConfig);
  }

  function enqueuePane(name, idx, agentDir, sharedConfig = null) {
    return queue.enqueue(paneKey(name, idx), { name, idx, agentDir, sharedConfig });
  }

  // --- fs.watch wiring -----------------------------------------------------

  function projectDirFor(agentDir, idx) {
    return claudeProjectDir(paneDir(agentDir, idx));
  }

  function attachFsWatch(name, idx, agentDir) {
    const key = paneKey(name, idx);
    if (fsWatchers.has(key)) return;
    const projectDir = projectDirFor(agentDir, idx);
    if (!existsSync(projectDir)) return; // will be picked up by polling once jsonl appears

    let debounceTimer = null;
    const trigger = () => {
      // Every fs.watch fire = jsonl write = pane is active. Refresh
      // typing-bubble immediately (throttled per-channel). Sub-second
      // latency from agent-write to Discord typing dot.
      maybeSendTyping(name, idx);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        enqueuePane(name, idx, agentDir);
      }, 500); // debounce — claude often writes 5-50 events per burst within 100-300ms
    };

    try {
      const w = watch(projectDir, { persistent: false }, () => trigger());
      w.on("error", (err) => log(`fs.watch error ${key}: ${err.message}`));
      fsWatchers.set(key, w);
    } catch (err) {
      log(`fs.watch attach failed ${key}: ${err.message} (polling will cover it)`);
    }
  }

  function detachAllFsWatch() {
    for (const w of fsWatchers.values()) {
      try { w.close(); } catch { /* ignore */ }
    }
    fsWatchers.clear();
  }

  // --- top-level loop ------------------------------------------------------

  async function tick() {
    if (stopped) return;
    let config;
    try { config = loadConfig(agentsYamlPath); }
    catch (err) {
      log(`config load failed: ${err.message}`);
      return;
    }

    for (const [name, entry] of Object.entries(config || {})) {
      if (!entry?.dir || !Array.isArray(entry.panes)) continue;
      for (let i = 0; i < entry.panes.length; i++) {
        const cmd = entry.panes[i]?.cmd || "";
        if (!/^(claude|codex)/.test(cmd)) continue;
        attachFsWatch(name, i, entry.dir);
        enqueuePane(name, i, entry.dir, config);
      }
    }
  }

  // Typing-indicator polling fallback. fs.watch is the primary driver
  // (see attachFsWatch's trigger), but on filesystems that silently drop
  // events (WSL 9p, some network mounts) we'd lose the indicator without
  // this sweep. Pure mtime check — no tmux capture, no detectPaneStatus.
  // If jsonl was written within the freshness window, the pane is active;
  // if a modal/idle state is up, mtime stays stale and we skip naturally.
  async function typingTick() {
    if (stopped) return;
    if (typeof discord.sendTyping !== "function") return;
    let config;
    try { config = loadConfig(agentsYamlPath); }
    catch { return; }

    const now = Date.now();
    for (const [name, entry] of Object.entries(config || {})) {
      if (!entry?.dir || !Array.isArray(entry.panes)) continue;
      for (let i = 0; i < entry.panes.length; i++) {
        const cmd = entry.panes[i]?.cmd || "";
        if (!/^(claude|codex)/.test(cmd)) continue;
        const dir = paneDir(entry.dir, i);
        // Dialect-dispatched mtime: codex sessions live under
        // ~/.codex/sessions, not ~/.claude/projects. Without this, codex
        // pane fs writes never show as fresh and typing-indicator stays off.
        const mtimeMs = /codex/i.test(cmd) ? latestCodexJsonlMtime(dir) : latestJsonlMtime(dir);
        if (!mtimeMs || now - mtimeMs > TYPING_FRESHNESS_MS) continue;
        maybeSendTyping(name, i, config);
      }
    }
  }

  return {
    start() {
      stopped = false;
      tick().catch((err) => log(`initial tick failed: ${err.message}`));
      pollTimer = setInterval(() => tick().catch(() => {}), pollMs);
      typingTimer = setInterval(() => typingTick().catch(() => {}), typingPollMs);
      log(`enabled | poll=${pollMs}ms grace=${COMPLETION_GRACE_MS}ms typing=${typingPollMs}ms (fs.watch + poll, persistent state)`);
    },
    stop() {
      stopped = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (typingTimer) { clearInterval(typingTimer); typingTimer = null; }
      detachAllFsWatch();
      queue.stop();
    },
    // Exposed for tests so we can drive tick/checkPane directly without
    // racing against the polling timer or fs.watch.
    tick,
    checkPane,
    enqueuePane,
  };
}
