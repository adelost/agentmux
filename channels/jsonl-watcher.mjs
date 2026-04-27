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

import { watch, statSync, existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { splitMessage, extractImageMarkers, validateImagePath } from "../lib.mjs";
import { loadConfig, findChannelForPane } from "../cli/config.mjs";
import { paneDir } from "../agent.mjs";
import { readLastTurns } from "../core/jsonl-reader.mjs";

const DEFAULT_POLL_MS = 15_000;
// A turn whose endTimestamp is older than this counts as "done writing"
// even if its stop_reason wasn't terminal (compacted sessions, crashed
// claude). Belt-and-suspenders so we never sit on a stale partial turn.
const COMPLETION_GRACE_MS = 5_000;
// Cap turns considered per pane per tick. Watcher posts the latest few
// missed turns at restart, not the entire history.
const TURN_LOOKBACK = 20;

const STATE_KEY_LAST_POSTED = "watcher_last_posted_ts";

export function createJsonlWatcher({
  agent,
  agentsYamlPath,
  discord,
  state,
  recorder = null,
  tts = null,
  pollMs = DEFAULT_POLL_MS,
  postPrefix = "",
  log = (msg) => console.log(`watcher | ${msg}`),
} = {}) {
  if (!agent) throw new Error("watcher: agent required");
  if (!agentsYamlPath) throw new Error("watcher: agentsYamlPath required");
  if (!discord) throw new Error("watcher: discord required");
  if (!state) throw new Error("watcher: state store required");

  /** active fs.watch handles per pane key (`name:idx`). */
  const fsWatchers = new Map();
  /** in-flight check guards so fs.watch + poll don't double-fire on the same pane. */
  const inFlight = new Set();
  let pollTimer = null;
  let stopped = false;

  const paneKey = (name, idx) => `${name}:${idx}`;

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

  // ALSO honour stampChannelMirror's clock so when streamResponse-or-similar
  // posts in the same process, we skip the same turn.
  function channelMirrorMs(channelId) {
    const map = state.get("channel_last_mirror_ts", {}) || {};
    const iso = map[channelId];
    if (!iso) return 0;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  // --- rendering -----------------------------------------------------------

  function renderTurn(turn) {
    const rawText = (turn.items || [])
      .map((it) => (it.type === "tool" ? `*${it.content}*` : it.content))
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
    return { fullText, validFiles };
  }

  async function postTurn({ name, idx, channelId, turn }) {
    const { fullText, validFiles } = renderTurn(turn);
    if (!fullText && validFiles.length === 0) return;

    const body = postPrefix && fullText ? `${postPrefix}${fullText}` : fullText || "(no text)";
    const chunks = splitMessage(body);
    // Pacing: Discord rate limit drops chunks in tight bursts.
    const pacePerChunk = chunks.length >= 2 ? (chunks.length > 3 ? 400 : 250) : 0;
    for (let i = 0; i < chunks.length; i++) {
      const payload = (i === 0 && validFiles.length)
        ? { content: chunks[i], files: validFiles }
        : chunks[i];
      try {
        await discord.send(channelId, payload);
      } catch (err) {
        log(`chunk ${i + 1}/${chunks.length} failed for ${name}:${idx}: ${err.message}`);
      }
      if (pacePerChunk > 0 && i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, pacePerChunk));
      }
    }

    // Context footer — same shape as streamResponse used to send.
    try {
      const ctx = agent.getContextPercent?.(name, idx);
      if (ctx) {
        const k = Math.round(ctx.tokens / 1000);
        await discord.send(channelId, `_context: ${ctx.percent}% (${k}k)_`)
          .catch((err) => log(`context-footer ${name}:${idx}: ${err.message}`));
      }
    } catch (err) {
      log(`context-footer skipped ${name}:${idx}: ${err.message}`);
    }

    // TTS
    if (tts?.isEnabled?.()) {
      const ttsText = (turn.items || [])
        .filter((it) => it.type === "text")
        .map((it) => it.content)
        .join("\n\n");
      if (ttsText) {
        try {
          // tts.sendFollowup expects (sendFn, text, tmpFiles).
          await tts.sendFollowup(
            (payload) => discord.send(channelId, payload),
            ttsText,
            [],
          );
        } catch (err) { log(`tts ${name}:${idx}: ${err.message}`); }
      }
    }

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
  }

  // --- core check ----------------------------------------------------------

  async function checkPane(name, idx, agentDir) {
    const key = paneKey(name, idx);
    if (inFlight.has(key)) return; // coalesce overlapping fs.watch + poll triggers
    inFlight.add(key);
    try {
      const channelId = findChannelForPane(agentsYamlPath, name, idx);
      if (!channelId) return;

      const dir = paneDir(agentDir, idx);
      const result = readLastTurns(dir, { limit: TURN_LOOKBACK });
      if (!result?.turns?.length) return;

      // First-time channel — stamp now, don't backpost history.
      let lastMs = lastPostedMs(channelId);
      if (lastMs === null) {
        const newest = result.turns[result.turns.length - 1];
        const ts = newest?.endTimestamp || newest?.timestamp;
        const seedMs = ts ? new Date(ts).getTime() : Date.now();
        setLastPostedMs(channelId, Number.isFinite(seedMs) ? seedMs : Date.now());
        log(`seeded ${name}:${idx} → ${channelId} @ ${new Date(seedMs).toISOString()}`);
        return;
      }

      // Honour stampChannelMirror clock — if a parallel forwarder posted
      // for this channel, treat that as our checkpoint too.
      const stampMs = channelMirrorMs(channelId);
      if (stampMs > lastMs) {
        lastMs = stampMs;
        setLastPostedMs(channelId, stampMs);
      }

      const now = Date.now();
      // Walk turns oldest → newest among the lookback, post any that
      // are after the checkpoint AND deemed complete.
      for (const turn of result.turns) {
        const endIso = turn.endTimestamp || turn.timestamp;
        if (!endIso) continue;
        const endMs = new Date(endIso).getTime();
        if (!Number.isFinite(endMs)) continue;
        if (endMs <= lastMs) continue;

        const completeByReason = !!turn.isComplete;
        const completeByGrace = now - endMs >= COMPLETION_GRACE_MS;
        if (!completeByReason && !completeByGrace) continue;

        await postTurn({ name, idx, channelId, turn });
        setLastPostedMs(channelId, endMs);
        lastMs = endMs;
        const ageS = Math.round((now - endMs) / 1000);
        const reason = completeByReason ? "stop_reason" : "grace";
        log(`${name}:${idx} → ${channelId} (${reason}, age=${ageS}s, ${turn.items?.length || 0} items)`);
      }
    } catch (err) {
      log(`check ${key}: ${err.stack || err.message}`);
    } finally {
      inFlight.delete(key);
    }
  }

  // --- fs.watch wiring -----------------------------------------------------

  // Mirror Claude Code's path encoding (every `/` and `.` → `-`).
  function encodeProjectPath(dir) {
    return dir.replace(/[\/\.]/g, "-");
  }
  function projectDirFor(agentDir, idx) {
    return join(
      process.env.HOME, ".claude", "projects",
      encodeProjectPath(paneDir(agentDir, idx)),
    );
  }

  function attachFsWatch(name, idx, agentDir) {
    const key = paneKey(name, idx);
    if (fsWatchers.has(key)) return;
    const projectDir = projectDirFor(agentDir, idx);
    if (!existsSync(projectDir)) return; // will be picked up by polling once jsonl appears

    let debounceTimer = null;
    const trigger = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        checkPane(name, idx, agentDir).catch(() => {});
      }, 250); // small debounce — claude may write multiple events in a burst
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
        await checkPane(name, i, entry.dir);
      }
    }
  }

  return {
    start() {
      stopped = false;
      tick().catch((err) => log(`initial tick failed: ${err.message}`));
      pollTimer = setInterval(() => tick().catch(() => {}), pollMs);
      log(`enabled | poll=${pollMs}ms grace=${COMPLETION_GRACE_MS}ms (fs.watch + poll, persistent state)`);
    },
    stop() {
      stopped = true;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      detachAllFsWatch();
    },
  };
}
