// Mirror-loop: safety-net forwarder for agent replies → bound Discord channels.
//
// Why this exists: drift-guard, resume-hint, and voice-PWA each have their
// own ad-hoc reply forwarders (matcher + timeout). Each one can fail quietly
// — timeout, matcher mismatch, transient pane state — and the user sees no
// reply in Discord even though the agent answered. handlers.streamResponse
// covers the synchronous Discord-→pane flow but nothing else.
//
// Mirror-loop polls every claude/codex pane's jsonl on a slow interval, finds
// the latest assistant turn, and posts it to the bound Discord channel IF
// no message has been mirrored to that channel since the turn was written.
//
// Dedupe leverages existing appState.channel_last_mirror_ts which is
// updated automatically by stampChannelMirror on every successful
// discord.send. No extra callbacks needed: any forwarder that posts to a
// channel updates the timestamp; mirror-loop sees the new timestamp on
// its next tick and skips. If a forwarder fails to post (drift-guard
// timeout, voice-PWA never wired up for outbound, etc), the timestamp
// stays old, mirror-loop crosses the grace period, and posts the gap-fill.
//
// Grace period (default 90s) gives the fast forwarders time to handle the
// happy path before the safety-net kicks in. Combined with handlers'
// streamResponse (~10s typical), users see replies within seconds in
// normal cases and within ~2 min in failure cases.
//
// On startup, mirror-loop seeds lastMirrored with the current latest turn
// timestamp per pane so it does NOT backpost the entire history.

import { readLastTurns } from "../core/jsonl-reader.mjs";
import { loadConfig, findChannelForPane } from "../cli/config.mjs";
import { paneDir } from "../agent.mjs";

const DEFAULT_POLL_MS = 30_000;
const DEFAULT_GRACE_MS = 90_000;

export function createMirrorLoop({
  agentsYamlPath,
  discord,
  state,
  pollMs = DEFAULT_POLL_MS,
  gracePeriodMs = DEFAULT_GRACE_MS,
  log = (msg) => console.log(`mirror-loop | ${msg}`),
} = {}) {
  if (!agentsYamlPath) throw new Error("mirror-loop: agentsYamlPath required");
  if (!discord) throw new Error("mirror-loop: discord channel required");
  if (!state) throw new Error("mirror-loop: state store required");

  /** Per-pane "last turn ts we considered" so we don't backpost on first run. */
  const seeded = new Map();
  let timer = null;

  const paneKey = (name, idx) => `${name}:${idx}`;

  function turnText(turn) {
    const parts = [];
    for (const item of turn.items || []) {
      if (item.type === "text" && item.content) parts.push(item.content);
      else if (item.type === "tool" && item.content) parts.push(`\`${item.content}\``);
    }
    return parts.join("\n").trim();
  }

  function channelMirrorMs(channelId) {
    const map = state.get("channel_last_mirror_ts", {}) || {};
    const iso = map[channelId];
    if (!iso) return 0;
    const ms = new Date(iso).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  async function checkPane(name, idx, agentDir) {
    const dir = paneDir(agentDir, idx);
    const result = readLastTurns(dir, { limit: 1 });
    if (!result || !result.turns.length) return;
    const turn = result.turns[result.turns.length - 1];
    if (!turn?.timestamp) return;
    const turnMs = new Date(turn.timestamp).getTime();
    if (!Number.isFinite(turnMs)) return;

    const k = paneKey(name, idx);

    // First sighting → seed only, don't post historical turns
    if (!seeded.has(k)) {
      seeded.set(k, turnMs);
      return;
    }
    // No new turn since last check → skip
    if (turnMs <= seeded.get(k)) return;

    const channelId = findChannelForPane(agentsYamlPath, name, idx);
    if (!channelId) {
      seeded.set(k, turnMs); // mark seen so we don't keep checking
      return;
    }

    // Dedupe via shared appState — any forwarder that already posted to
    // this channel after the turn timestamp counts as covered.
    const lastMirrorMs = channelMirrorMs(channelId);
    if (lastMirrorMs >= turnMs) {
      seeded.set(k, turnMs);
      return;
    }

    // Within grace window: dedicated forwarder may still handle it
    if (Date.now() - turnMs < gracePeriodMs) return;

    const text = turnText(turn);
    if (!text) {
      seeded.set(k, turnMs);
      return;
    }

    const ageS = Math.round((Date.now() - turnMs) / 1000);
    try {
      const body = `[mirror-loop · gap-fill ${ageS}s] ${text.slice(0, 1800)}`;
      await discord.send(channelId, body);
      seeded.set(k, turnMs);
      log(`${name}:${idx} → ${channelId} (gap-fill, age=${ageS}s)`);
    } catch (err) {
      log(`post failed ${name}:${idx}: ${err.message}`);
      // Don't update seeded — we'll retry next tick
    }
  }

  async function tick() {
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
        try { await checkPane(name, i, entry.dir); }
        catch (err) { log(`check failed ${name}:${i}: ${err.message}`); }
      }
    }
  }

  return {
    start() {
      tick().catch((err) => log(`initial tick failed: ${err.message}`));
      timer = setInterval(() => tick().catch(() => {}), pollMs);
      log(`enabled | poll=${pollMs}ms grace=${gracePeriodMs}ms`);
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
