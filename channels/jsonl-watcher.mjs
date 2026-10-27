// One persistent JSONL mirror owns completed replies, native typing and recovery.
// fs.watch plus bounded polling covers WSL missed events; stable item IDs retain
// restart dedupe. Terminal chrome never becomes reply text.
import { watch, statSync, existsSync } from "fs";
import { join } from "path";
import { splitMessage, extractImageMarkers, validateImagePath, chunkAttachments } from "../lib.mjs";
import { loadConfig, findChannelForPane, channelForPane } from "../cli/config.mjs";
import { paneDir } from "../agent.mjs";
import { claudeProjectDir } from "../core/claude-paths.mjs";
import { latestJsonlMtime } from "../core/jsonl-reader.mjs";
import { alternateEngineForCommand, sessionReaderForCommand, alternateWatchDir, latestAlternateMtime } from "../core/alternate-session-reader.mjs";
import { createGeminiTmuxMirror } from "../core/gemini-tmux-mirror.mjs";
import { getContextFromPane } from "../core/context.mjs";
import { jsonlContextFooter } from "../core/context-footer.mjs";
import { isHarnessPlaceholder } from "../core/reply-forwarder.mjs";
import { applyPostFailure, applyPostSuccess, planPaneMirrorStep, planStartupAudit, itemKey } from "../core/watcher-engine.mjs";
import {
  classifyModelChange, changeMessage, stopBrief, shouldStopPane, label as modelLabel,
  decideRecovery, resumeBrief, recoveryMessage, interruptUntilIdle,
  MODEL_RECOVERY_STATE_KEY, MODEL_RECOVERY_SETTLE_MS, MODEL_RECOVERY_TIMEOUT_MS,
} from "../core/model-watch.mjs";
import { driveCodexStatus } from "../core/codex-status.mjs";
import { isExpectedCodexModel, selectedCodexProfile, setCodexModelOverride } from "../core/codex-profiles.mjs";
import { sendSlashVerified } from "../core/delivery.mjs";
import { parkPane, unparkPane } from "../core/pane-park.mjs";
import { appendEvent } from "../core/events.mjs";
import { notifyUser } from "../cli/send-notify.mjs";
import { createPaneQueue } from "../core/pane-queue.mjs";
import { createLiveProgress } from "./live-progress.mjs";
import { openWatcherJournal } from "../core/watcher-journal.mjs";
import { timedWatcherStep } from "../core/watcher-timing.mjs";
import { compactionNoticeText } from "../core/compaction-notice.mjs";
import { announceNewPaneEvents } from "../core/pane-notices.mjs";
import { planQuotaStopMirror } from "../core/watcher-quota-stop.mjs";
import { refusalNoticeText } from "../core/codex-refusal-notice.mjs";
import { isCodexCapacityError } from "../core/codex-capacity-recovery.mjs";
import { createCodexRecovery } from "../cli/codex-recovery.mjs";
import { isPaneModelSwitchReading, paneModelSelection, recordPaneModelReading, setPaneModelSelection } from "../core/pane-model-state.mjs";
import { settleLandedClaudeModelSwitch } from "../core/claude-model-command.mjs";
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
const STATE_KEY_RETRY_UNTIL = "watcher_retry_until_ts";
const STATE_KEY_COMPACTION_IDS = "watcher_compaction_ids";
const STATE_KEY_REFUSAL_IDS = "watcher_refusal_ids";
const STATE_KEY_CUSTOM_TOOLS_SEEDED = "watcher_custom_tools_seeded";
/**
 * WHAT: Routes completed Claude and Codex JSONL items to their bound channels.
 * WHY: Keeps response forwarding restart-safe and independent of terminal scrollback.
 */
export function createJsonlWatcher({
  agent,
  deliveryBroker = null,
  agentsYamlPath,
  discord,
  state,
  recorder = null,
  tts = null,
  claimGuard = null,
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
  const journal = openWatcherJournal({ state, log }); // posted ids and the work row, out of the state file
  const progress = createLiveProgress({ discord, state, journal, log });
  const fsWatchers = new Map();
  /** per-channel last-sendTyping ms, throttled via TYPING_THROTTLE_MS. */
  const lastTypingAt = new Map();
  // Cache journal identity, recovery evidence and the next mirror deadline.
  const readSnapshots = new Map();
  // Panes audited since THIS bridge started — the startup self-heal runs once
  // per pane, then the normal cursor engine owns the stream again.
  const auditedPanes = new Set();
  const metricsEnabled = process.env.AMUX_WATCHER_METRICS === "1";
  let pollTimer = null;
  let typingTimer = null;
  let stopped = false;
  const codexRecovery = createCodexRecovery({ state, broker: deliveryBroker, agent, log, configPath: agentsYamlPath,
    notify: (text, target) => discord.send(findChannelForPane(agentsYamlPath, target.name, target.pane), text) });

  const paneKey = (name, idx) => `${name}:${idx}`;
  const geminiMirror = createGeminiTmuxMirror({ agent, state, post: request => postTurn(request) });
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

  const postedItemIds = (channelId) => journal.posted(channelId);
  const setPostedItemIds = (channelId, ids) => journal.setPosted(channelId, ids);

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

  const STATE_KEY_RECOVERY = MODEL_RECOVERY_STATE_KEY;
  // Auto-recovery drives `/model <prev>` to switch a downgraded pane back to
  // the model it held before. When that model is EXHAUSTED (the operator 2026-07-12:
  // out of Fable 5) the switch-back keeps re-selecting a quota-dead model and
  // interrupts live turns to do it. Default OFF now — opt in with
  // AMUX_MODEL_RECOVERY=true when the quota is back.
  const recoveryEnabled = process.env.AMUX_MODEL_RECOVERY === "true";

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
    attempts[key] = {
      ...attempts[key],
      attemptedAtMs: Date.now(),
      target: modelLabel(prev),
      targetModel: prev.model,
      targetEffort: prev.effort ?? null,
    };
    state.set(STATE_KEY_RECOVERY, attempts);

    // Let the interrupted TUI settle before replacing its process. This also
    // keeps a late task_complete flush from racing the restart boundary.
    await new Promise((resolve) => setTimeout(resolve, MODEL_RECOVERY_SETTLE_MS));
    try {
      if (await agent.isBusy(name, idx)) {
        const detail = "pane became busy during 10s recovery settle";
        await discord.send(channelId, recoveryMessage(paneName, false, detail));
        return { attempted: true, restored: false, detail };
      }
    } catch (err) {
      const detail = `idle re-check failed: ${err.message}`;
      await discord.send(channelId, recoveryMessage(paneName, false, detail));
      return { attempted: true, restored: false, detail };
    }

    const paneCmd = config?.[name]?.panes?.[idx]?.cmd || "";
    let restored = false;
    let detail = "";
    try {
      if (/codex/i.test(paneCmd)) {
        // TUI /model persists to the account-wide config.toml and historically
        // upgraded every other pane on reboot. Restart+resume with -m/-c is
        // process-local, then native /status proves the effective result.
        const profile = selectedCodexProfile(state, name, idx);
        setCodexModelOverride(state, name, idx, prev.model, prev.effort || null);
        await agent.restartCodex(name, idx, {
          profile,
          model: prev.model,
          effort: prev.effort || null,
        });
        const res = await driveCodexStatus({
          agent, name, pane: idx, log, timeoutMs: MODEL_RECOVERY_TIMEOUT_MS,
        });
        const actual = res.ok ? res.status.model : null;
        restored = Boolean(res.ok && actual?.id === prev.model &&
          (!prev.effort || actual?.effort === prev.effort));
        detail = restored
          ? `${actual.id}${actual.effort ? ` ${actual.effort}` : ""}`
          : res.ok
            ? `status shows ${actual?.id || "unknown"}${actual?.effort ? ` ${actual.effort}` : ""}`
            : `${res.stage}: ${res.error}`;
      } else {
        const sent = deliveryBroker
          ? await deliveryBroker.enqueueAndWait({
              agentName: name,
              pane: idx,
              text: `/model ${prev.model}`,
              kind: "slash",
              source: "model-watch",
            })
          : await sendSlashVerified(agent, name, idx, `/model ${prev.model}`);
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
      setPaneModelSelection(state, name, idx, prev.model, prev.effort ?? null);
      try {
        const text = resumeBrief(modelLabel(prev));
        if (deliveryBroker) deliveryBroker.enqueue({ agentName: name, pane: idx, text, source: "model-watch" });
        else await agent.sendOnly(name, text, idx);
      }
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
    // Only this pane's latest turn is model-change evidence.
    if (ctx.modelSource && ctx.modelSource !== "turn") return;
    const key = paneKey(name, idx);
    const prev = paneModelSelection(state, name, idx);
    const next = { model: ctx.model, effort: recordPaneModelReading(state, name, idx, ctx.model, ctx.effort ?? null).effort };
    if (isExpectedCodexModel(state, name, idx, config?.[name]?.panes?.[idx], next)) return;
    // amux model is switching this pane on purpose; its old and new model are both expected.
    if (isPaneModelSwitchReading(state, name, idx, next)) return settleLandedClaudeModelSwitch(state, name, idx, next);
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
    notifyUser(`${paneName} downgraded and STOPPED: ${change.from} → ${change.to}. Nudge it when the state is right.`)
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
        `**${paneName}: the stop could not be verified** (${interruption.detail}). ` +
        "The pane is still parked and takes no new briefs; interrupt it by hand with `amux esc`.")
        .catch((err) => log(`model-change stop failure line failed for ${paneName}: ${err.message}`));
      return;
    }
    log(`${paneName} stopped after ${interruption.escapes} Escape attempt(s)`);

    const recoveryState = state.get(STATE_KEY_RECOVERY, {}) || {};
    recoveryState[key] = {
      ...recoveryState[key],
      incidentAtMs: Date.now(),
      target: modelLabel(prev),
      targetModel: prev.model,
      targetEffort: prev.effort ?? null,
    };
    state.set(STATE_KEY_RECOVERY, recoveryState);

    // Recover while the pane is neutral. The old order sent stopBrief first;
    // that started a new turn, so the Codex recovery correctly refused the
    // busy pane and defeated itself. Only brief the downgraded model
    // when recovery was skipped or failed.
    const recovery = await attemptModelRecovery({ name, idx, paneName, channelId, prev, config });
    if (!recovery.restored) {
      try {
        const text = stopBrief(change);
        if (deliveryBroker) deliveryBroker.enqueue({ agentName: name, pane: idx, text, source: "model-watch" });
        else await agent.sendOnly(name, text, idx);
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
      else failedMarkers.push(`image skipped: \`${p}\` (${result.error})`);
    }
    const fullText = [cleanedText, ...failedMarkers].filter(Boolean).join("\n\n");
    return { fullText, validFiles, hasNarrative };
  }

  async function postTurn({ name, idx, channelId, turn, config = null }) {
    const quotaKey = `watcher_quota_episode:${name}:${idx}`;
    const quota = planQuotaStopMirror(turn, state.get(quotaKey, null));
    turn = await progress.update({ channelId, paneKey: `${name}:${idx}`, turn: quota.turn });
    let { fullText, validFiles, hasNarrative } = renderTurn(turn);
    if (!fullText && validFiles.length === 0) { state.set(quotaKey, quota.next); return { ok: true }; }
    // "No response requested." is Claude Code answering a harness-injected
    // notification (dead background task, resume bookkeeping) — not the
    // agent talking. Mirroring it reads as a refusal to answer; the real
    // reply arrives as its own turn right after. Skip text AND footer.
    if (isHarnessPlaceholder(fullText) && validFiles.length === 0) return { ok: true };
    if (claimGuard && turn.isComplete !== false) {
      const checked = await claimGuard.assess({ paneKey: `${name}:${idx}`, channelId,
        turnId: `jsonl:${name}:${idx}:${turn.timestamp || turn.endTimestamp}`, prompt: turn.userPrompt, text: fullText, files: validFiles });
      if (checked.held) return { ok: true };
      fullText = checked.text;
    }

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
        await discord.send(channelId, payload, { kind: "reply" });
      } catch (err) {
        ok = false;
        log(`chunk ${i + 1}/${chunks.length} failed for ${name}:${idx}: ${err.message}`);
      }
      if (i < chunks.length - 1) await pace();
    }
    for (let g = 1; g < fileGroups.length; g++) {
      await pace();
      try {
        await discord.send(channelId, { files: fileGroups[g] }, { kind: "file" });
      } catch (err) {
        ok = false;
        log(`file group ${g + 1}/${fileGroups.length} failed for ${name}:${idx}: ${err.message}`);
      }
    }
    if (!ok) return { ok: false };
    state.set(quotaKey, quota.next);

    // Match the pane-first context measurement used by auto-compact.
    // agent.getContext owns the terminal reading and JSONL fallback.
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
        const paneCmd = String(config?.[name]?.panes?.[idx]?.cmd || "");
        if (alternateEngineForCommand(paneCmd) !== "kimi") await watchModelChange({ name, idx, channelId, ctx, config })
          .catch((err) => log(`model-watch failed for ${name}:${idx}: ${err.message}`));
        await discord.send(channelId, jsonlContextFooter(ctx, progress.takeChanged(channelId)))
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

  /** WHAT: Resolves each pane's reader. WHY: Keeps generated non-Claude commands separate from the Claude fallback. */
  const readerFor = (config, name, idx) => sessionReaderForCommand(config?.[name]?.panes?.[idx]?.cmd || "");

  function sameFileStamp(a, b) {
    return !!a && !!b && a.path === b.path && a.mtimeMs === b.mtimeMs && a.size === b.size;
  }

  function estimatedReadBytes(info, tailBytes = WATCHER_TAIL_BYTES) {
    if (!info?.size) return 0;
    return Math.min(info.size, tailBytes);
  }

  function metric(msg) {
    if (metricsEnabled || Number(msg.match(/\bms=(\d+)/u)?.[1]) >= 1000) log(`metrics | ${msg}`);
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

  function rememberReadSnapshot(key, info, turns, channelId, latestMtimeMs, result) {
    if (!info) {
      readSnapshots.delete(key);
      return;
    }
    readSnapshots.set(key, {
      ...info,
      graceDueAtMs: pendingGraceDueAt(turns, channelId, latestMtimeMs),
      recovery: result && { refusals: result.refusals, refusalCandidates: result.refusalCandidates, lastPrompt: result.lastPrompt, jsonlFile: result.jsonlFile },
    });
  }

  async function processPane(name, idx, agentDir, sharedConfig = null) {
    try {
      const config = sharedConfig || loadConfig(agentsYamlPath);
      const channelId = channelForPane(config, name, idx);
      if (!channelId) return;
      if (config[name]?.panes?.[idx]?.engine === "gemini") return geminiMirror.poll({ name, idx, channelId, config, dir: paneDir(agentDir, idx) });

      const dir = paneDir(agentDir, idx);
      const key = paneKey(name, idx);
      await timedWatcherStep(`${key} progress`, () => progress.reconcile(channelId), log);
      const { readTurns, latestMtime, latestInfo } = readerFor(config, name, idx);
      const now = Date.now();
      const fileInfo = latestInfo(dir);
      const cached = readSnapshots.get(key);
      const retryUntil = retryUntilMs(channelId);
      const retryDue = Number.isFinite(retryUntil) && retryUntil <= now;
      const graceDue = Number.isFinite(cached?.graceDueAtMs) && cached.graceDueAtMs <= now;
      const startupAudit = !auditedPanes.has(key);

      if (sameFileStamp(cached, fileInfo) && !retryDue && !graceDue) {
        await timedWatcherStep(`${key} recovery-idle`, () => codexRecovery.tick({ name, pane: idx, dir, result: cached.recovery, idleBoundary: true }), log);
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
      await timedWatcherStep(`${key} recovery`, () => codexRecovery.tick({ name, pane: idx, dir, result }), log);
      await timedWatcherStep(`${key} progress-read`, () => progress.reconcile(channelId, result?.turns || []), log);
      const truncated = Number.isFinite(fileInfo?.size) && fileInfo.size > tailBytes;
      const readMs = Date.now() - readStarted;
      const readBytes = estimatedReadBytes(fileInfo, tailBytes);
      const notice = { state, channelId, send: (to, text) => discord.send(to, text), log, paneName: `${name}:${idx}` };
      await announceNewPaneEvents({ ...notice, stateKey: STATE_KEY_COMPACTION_IDS, kind: "compaction",
        events: result?.compactions || [], text: unseen => compactionNoticeText(`${name}:${idx}`, unseen) });
      await announceNewPaneEvents({ ...notice, stateKey: STATE_KEY_REFUSAL_IDS, kind: "unanswered-turn",
        events: result?.refusals || [], text: unseen => refusalNoticeText(`${name}:${idx}`, unseen, unseen.at(-1).reason,
          { autoCapacity: !!deliveryBroker && isCodexCapacityError(unseen.at(-1).reason) }) });
      seedCustomToolMigration(channelId, result?.turns || []);
      if (!result?.turns?.length) {
        rememberReadSnapshot(key, fileInfo, [], channelId, fileInfo?.mtimeMs ?? null, result);
        metric(`${key} read bytes=${readBytes} ms=${readMs} turns=0`);
        return { readBytes, readMs };
      }

      const mtimeMs = fileInfo?.mtimeMs ?? latestMtime(dir);

      // Startup self-heal: post anything a previous bridge completed but never
      // delivered (kill -9 mid-grace loses the item forever once the cursor
      // moves during a restart). Id-dedupe makes re-runs safe.
      if (startupAudit) {
        auditedPanes.add(key);
        const audit = planStartupAudit({
          turns: result.turns,
          postedItemIds: postedItemIds(channelId),
          nowMs: now,
        });
        for (const action of audit.actions) {
          const posted = await timedWatcherStep(`${key} audit-post`, () => postTurn({ name, idx, channelId, turn: action.turn, config }), log);
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
        if (audit.skippedItems > 0) {
          log(`${name}:${idx} audit capped: skipped ${audit.skippedItems} older missed item(s) across ${audit.skippedTurns} turn(s) to avoid a restart flood`);
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
        const result = await timedWatcherStep(`${key} post`, () => postTurn({ name, idx, channelId, turn: action.turn, config }), log);
        if (!result?.ok) {
          const nextState = applyPostFailure({
            lastPostedMs: lastPostedMs(channelId),
            postedItemIds: postedItemIds(channelId),
            retryUntilMs: retryUntilMs(channelId),
          }, action, { nowMs: now, retryBackoffMs: RETRY_BACKOFF_MS });
          commitEngineState(channelId, nextState);
          log(`${name}:${idx} → ${channelId} main post failed; retry after ${Math.round(RETRY_BACKOFF_MS / 1000)}s`);
          rememberReadSnapshot(key, fileInfo, result.turns, channelId, mtimeMs, result);
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

      rememberReadSnapshot(key, fileInfo, result.turns, channelId, mtimeMs, result);
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

  function projectDirFor(agentDir, idx, config, name) {
    const dir = paneDir(agentDir, idx);
    return alternateWatchDir(config?.[name]?.panes?.[idx]?.cmd, dir) || claudeProjectDir(dir);
  }

  function attachFsWatch(name, idx, agentDir, config) {
    const key = paneKey(name, idx);
    if (fsWatchers.has(key)) return;
    const projectDir = projectDirFor(agentDir, idx, config, name);
    if (!projectDir || !existsSync(projectDir)) return; // picked up by polling once jsonl appears

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
      if (entry.backend === "native") continue;
      for (let i = 0; i < entry.panes.length; i++) {
        const cmd = entry.panes[i]?.cmd || "";
        if (entry.panes[i]?.engine === "gemini") { enqueuePane(name, i, entry.dir, config); continue; }
        if (!/(?:^|[/\s])(claude|codex|kimi(?:-code)?|qwen)(?:\s|$)/u.test(cmd)) continue;
        attachFsWatch(name, i, entry.dir, config);
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
      if (entry.backend === "native") continue;
      for (let i = 0; i < entry.panes.length; i++) {
        const cmd = entry.panes[i]?.cmd || "";
        if (!/(?:^|[/\s])(claude|codex|kimi(?:-code)?|qwen)(?:\s|$)/u.test(cmd)) continue;
        const dir = paneDir(entry.dir, i);
        // Dialect-dispatched mtime: codex sessions live under
        // ~/.codex/sessions, not ~/.claude/projects. Without this, codex
        // pane fs writes never show as fresh and typing-indicator stays off.
        const mtimeMs = latestAlternateMtime(cmd, dir, { observe: true }) || latestJsonlMtime(dir);
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
