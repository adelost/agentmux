// Message handling: commands, agent routing, reply pipeline.
// Channel-agnostic. Works with any ChannelMessage from channels/*.mjs.

import { splitMessage, parsePane, parseCommand, parseUseArg, extractImageMarkers, validateImagePath } from "./lib.mjs";
import { readFileSync, unlinkSync, statSync } from "fs";
import { executeSync } from "./core/sync-discord.mjs";
import { countTurnsSince, panePathFor, readLastTurns } from "./core/jsonl-reader.mjs";
import { checkLoopGuard, loopGuardKey, formatLoopGuardWarning, readLoopGuardConfig } from "./core/loop-guard.mjs";
import { formatCatchupPreview } from "./core/catchup-format.mjs";

function cleanupTmpFiles(files) {
  for (const f of files) {
    try { unlinkSync(f); }
    catch (err) {
      // File may have been cleaned up elsewhere; only surface unexpected errors
      if (err.code !== "ENOENT") console.warn(`cleanupTmpFiles: ${f}: ${err.message}`);
    }
  }
}

const HELP_TEXT = [
  "**Commands:**",
  "`/help` — show this message",
  "`/peek` — last response from agent",
  "`/raw` — last 50 lines of tmux pane (raw)",
  "`/status` — current agent, pane, context%",
  "`/dismiss` — dismiss blocking prompt (survey etc.)",
  "`/esc` — interrupt (send Escape)",
  "`/use <agent>[.pane]` — switch channel target",
  "`/use reset` — back to yaml default",
  "`/codex [--force]` — switch this pane to Codex",
  "`/claude [--force]` — switch this pane to Claude Code",
  "`/thinking` — toggle real-time text streaming (default: on)",
  "`/follow` — toggle: stream output even when typing in tmux",
  "`/tts` — toggle text-to-speech for this channel",
  "`/sync` — create/sync Discord channels from agentmux.yaml",
  "`/reload` — reload agents.yaml",
  "`/restart` — restart agentmux",
  "",
  "Prefix with `.N` to target pane N (e.g. `.1 /raw`)",
].join("\n");

function formatContext(ctx) {
  if (!ctx) return "";
  const k = Math.round(ctx.tokens / 1000);
  return `\n_context: ${ctx.percent}% (${k}k)_`;
}

function sendTextReply(msg, text, context) {
  const chunks = splitMessage(text);
  const ctxSuffix = formatContext(context);
  // See processMessage's pace rationale: Discord can drop rapid-fire chunks.
  const pacePerChunk = chunks.length >= 2 ? (chunks.length > 3 ? 400 : 250) : 0;
  return (async () => {
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      try {
        await msg.reply(isLast ? chunks[i] + ctxSuffix : chunks[i]);
      } catch (err) {
        console.warn(`reply chunk ${i + 1}/${chunks.length} failed: ${err.message}`);
      }
      if (pacePerChunk > 0 && !isLast) {
        await new Promise((r) => setTimeout(r, pacePerChunk));
      }
    }
  })();
}

function formatAgentError(err) {
  return err?.killed ? "Timeout" : `${err?.stderr || err?.message || err}`;
}

function hasForceFlag(args = "") {
  return args.split(/\s+/).some((arg) => arg === "--force" || arg === "-f" || arg === "force");
}

/** Render a catch-up notice timestamp. HH:MM when the turn is same-day,
 *  otherwise YYYY-MM-DD HH:MM so the user doesn't misread a days-old
 *  turn as recent. */
export function formatCatchupTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hhmm;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hhmm}`;
}

/**
 * Decide whether to post a catch-up notice, and return the line to post.
 * Pure function: takes the count result + last-timestamp, returns a string
 * or null. Extracted so unit tests can verify the rendering without
 * wiring up the full handlers module.
 *
 * @param {{count: number, latest: string|null, capped: boolean}|null} countResult
 * @returns {string|null}  line to post, or null for no-notice (count=0 or null)
 */
export function renderCatchupLine(countResult) {
  if (!countResult || countResult.count <= 0) return null;
  const label = countResult.capped ? "50+" : String(countResult.count);
  if (countResult.capped) {
    return `ℹ ${label} turns since last Discord sync — you've been busy!`;
  }
  const latest = countResult.latest ? formatCatchupTime(countResult.latest) : null;
  return latest
    ? `ℹ ${label} turns since your last Discord sync (latest: ${latest})`
    : `ℹ ${label} turns since your last Discord sync`;
}

/**
 * Create message handler with all dependencies injected.
 * @param {{ agent, attachments, tts, getMapping, overrides, channelMap, reloadConfig, discordChannel?, agentmuxYamlPath?, agentsYamlPath? }} deps
 */
export function createHandlers({ agent, attachments, tts, state, getMapping, overrides, channelMap, reloadConfig, discordChannel, agentmuxYamlPath, agentsYamlPath, recorder, pollInterval = 2000, loopGuardConfig = readLoopGuardConfig() }) {
  const noopRecorder = { save: () => {}, enabled: false };
  const rec = recorder || noopRecorder;
  const sendLocks = new Map();
  const followers = new Map(); // channelId → { timer, sentCount, lastHash }

  function withPaneSendLock(queueKey, work) {
    const prev = sendLocks.get(queueKey) || Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    let tracked;
    tracked = next.finally(() => {
      if (sendLocks.get(queueKey) === tracked) sendLocks.delete(queueKey);
    });
    sendLocks.set(queueKey, tracked);
    return tracked;
  }

  function startFollow(msg, mapping, pane) {
    const key = msg.channelId;
    if (followers.has(key)) {
      clearInterval(followers.get(key).timer);
      followers.delete(key);
      state.set("follow", { ...state.get("follow", {}), [key]: false });
      return msg.reply("follow **off**");
    }

    let sentCount = 0;
    let lastHash = "";
    let wasIdle = true;

    const timer = setInterval(async () => {
      try {
        const busy = await agent.isBusy(mapping.name, pane);

        if (busy && wasIdle) {
          // Transition idle → busy: reset tracking for new turn
          sentCount = 0;
          lastHash = "";
          wasIdle = false;
        }

        if (!busy && !wasIdle) {
          // Transition busy → idle: send any remaining segments
          const segments = await agent.getResponseSegments(mapping.name, pane);
          const unsent = segments.slice(sentCount);
          if (unsent.length) {
            const text = unsent.join("\n\n").trim();
            const context = agent.getContextPercent(mapping.name, pane);
            for (const chunk of splitMessage(text + formatContext(context))) {
              await msg.send(chunk).catch((err) =>
                console.warn(`follow: send chunk failed: ${err.message}`));
            }
            sentCount = segments.length;
          }
          wasIdle = true;
          return;
        }

        if (!busy) return; // idle, nothing to do

        // Busy: stream complete segments (all except last which may still grow)
        // Batch all new segments per tick into one message
        const segments = await agent.getResponseSegments(mapping.name, pane);
        if (segments.length > 1 && sentCount < segments.length - 1) {
          const batch = [];
          while (sentCount < segments.length - 1) {
            batch.push(segments[sentCount]);
            sentCount++;
          }
          await msg.send(batch.join("\n\n")).catch((err) =>
            console.warn(`follow: send segment failed: ${err.message}`));
        }
      } catch (err) {
        console.warn(`follow: poll tick failed: ${err.message}`);
      }
    }, 3000);

    followers.set(key, { timer, stop: () => clearInterval(timer) });
    state.set("follow", { ...state.get("follow", {}), [key]: true });
    return msg.reply("follow **on** — output streams here even from tmux");
  }

  const commands = {
    "/help": async (msg) => {
      await msg.reply(HELP_TEXT);
    },

    "/peek": async (msg, mapping, pane) => {
      const busy = await agent.isBusy(mapping.name, pane);
      if (!busy) {
        const text = await agent.getResponse(mapping.name, pane);
        const context = agent.getContextPercent(mapping.name, pane);
        await sendTextReply(msg, text, context);
        return;
      }
      // Agent is working, follow with streaming until idle
      const streaming = state.get("thinking", true);
      const progress = agent.startProgressTimer(msg.send, mapping.name, pane, { streaming });
      await new Promise((resolve) => {
        let idleSince = 0;
        const check = setInterval(async () => {
          try {
            const busy = await agent.isBusy(mapping.name, pane);
            if (busy) { idleSince = 0; return; }
            // Grace period: wait 4s idle before stopping (gap between messages)
            if (!idleSince) { idleSince = Date.now(); return; }
            if (Date.now() - idleSince < 4000) return;

            clearInterval(check);
            clearInterval(progress.timer);
            const segments = await agent.getResponseSegments(mapping.name, pane);
            const unsent = segments.slice(progress.sentCount());
            const text = unsent.join("\n\n").trim();
            const context = agent.getContextPercent(mapping.name, pane);
            if (text) await sendTextReply(msg, text, context);
            else if (context) await msg.reply(formatContext(context).trim());
            resolve();
          } catch (err) {
            console.warn(`/peek follow: poll failed: ${err.message}`);
            clearInterval(check);
            clearInterval(progress.timer);
            resolve();
          }
        }, 3000);
      });
    },

    "/raw": async (msg, mapping, pane) => {
      const text = await agent.capturePane(mapping.name, pane);
      const context = agent.getContextPercent(mapping.name, pane);
      await sendTextReply(msg, text, context);
    },

    "/status": async (msg, mapping, pane) => {
      const override = overrides.has(msg.channelId) ? " (override)" : "";
      const context = agent.getContextPercent(mapping.name, pane);
      const ctxStr = context ? `${context.percent}% (${Math.round(context.tokens / 1000)}k)` : "unknown";
      await msg.reply(`**${mapping.name}** pane ${pane}${override} · context: ${ctxStr}`);
    },

    "/dismiss": async (msg, mapping, pane) => {
      const target = `${mapping.name}:.${pane}`;
      const dismissed = await agent.dismissBlockingPrompt(target);
      await msg.reply(dismissed ? "dismissed" : "nothing to dismiss");
    },

    "/esc": async (msg, mapping, pane) => {
      await agent.sendEscape(mapping.name, pane);
      await msg.reply("sent Escape");
    },

    "/thinking": async (msg) => {
      const enabled = state.toggle("thinking");
      await msg.reply(`thinking ${enabled ? "on" : "off"}`);
    },

    "/tts": async (msg) => {
      const enabled = tts.toggle();
      await msg.reply(`TTS ${enabled ? "on" : "off"}`);
    },

    "/follow": async (msg, mapping, pane) => {
      await startFollow(msg, mapping, pane);
    },

    "/codex": async (msg, mapping, pane, args = "") => {
      const result = await agent.switchRuntime(mapping.name, pane, "codex", { force: hasForceFlag(args) });
      await msg.reply(`switched **${result.agentName}** pane ${result.pane} to **Codex**`);
    },

    "/claude": async (msg, mapping, pane, args = "") => {
      const result = await agent.switchRuntime(mapping.name, pane, "claude", { force: hasForceFlag(args) });
      await msg.reply(`switched **${result.agentName}** pane ${result.pane} to **Claude Code**`);
    },

    "/sync": async (msg) => {
      if (!discordChannel || !agentmuxYamlPath) {
        await msg.reply("sync not configured (missing agentmux.yaml path or discord channel)");
        return;
      }
      if (state.get("syncRunning")) {
        await msg.reply("sync already in progress");
        return;
      }
      state.set("syncRunning", true);
      try {
        await msg.reply("syncing...");
        const configYaml = readFileSync(agentmuxYamlPath, "utf-8");
        const { guild: guildId } = await import("./sync.mjs").then((m) => m.parseConfig(configYaml));
        const guild = await discordChannel.getGuild(guildId);
        const results = await executeSync({ guild, configYaml, state, agentsYamlPath });
        reloadConfig();

        // Reconcile live tmux sessions against the freshly-regenerated config.
        // Fixes the case where agentmux.yaml `panes` changed but the running
        // session still has old panes with wrong commands (bash where claude
        // is expected, etc).
        const reconcileSummaries = [];
        try {
          const { parseConfig } = await import("./sync.mjs");
          const cfg = parseConfig(configYaml);
          for (const agentName of cfg.agents.keys()) {
            try {
              const summary = await agent.reconcileSession(agentName);
              if (summary && !summary.skipped && (summary.added || summary.respawned.length || summary.mismatches?.length || summary.extras)) {
                reconcileSummaries.push(summary);
              }
            } catch (err) {
              console.warn(`/sync: reconcile ${agentName} failed: ${err.message}`);
            }
          }
        } catch (err) {
          console.warn(`/sync: reconcile skipped: ${err.message}`);
        }

        const lines = [];
        if (results.created.length) lines.push(`**created:** ${results.created.join(", ")}`);
        if (results.renamed?.length) lines.push(`**renamed:** ${results.renamed.join(", ")}`);
        if (results.existing.length) lines.push(`**existing:** ${results.existing.join(", ")}`);
        if (results.orphaned.length) lines.push(`**orphaned (not deleted):** ${results.orphaned.join(", ")}`);
        for (const s of reconcileSummaries) {
          const parts = [];
          if (s.added) parts.push(`+${s.added} pane(s)`);
          if (s.respawned.length) parts.push(`respawned ${s.respawned.map((r) => `p${r.pane} (${r.was}→${r.expected})`).join(", ")}`);
          if (s.mismatches?.length) parts.push(`mismatched (claude running, not touched): ${s.mismatches.map((m) => `p${m.pane} (${m.has} vs ${m.expected})`).join(", ")}`);
          if (s.extras) parts.push(`${s.extras} extra pane(s) left untouched`);
          lines.push(`**${s.name} session:** ${parts.join("; ")}`);
        }
        const total = results.created.length + (results.renamed?.length || 0) + results.existing.length;
        lines.push(`${total} channel(s) synced`);
        await msg.reply(lines.join("\n"));
      } catch (err) {
        await msg.reply(`sync failed: ${err.message}`);
      } finally {
        state.set("syncRunning", false);
      }
    },

    "/reload": async (msg) => {
      reloadConfig();
      await msg.reply(`reloaded: ${channelMap().size} channel mapping(s)`);
    },

    "/restart": async (msg) => {
      await msg.reply("restarting...");
      state.set("restartChannel", msg.channelId);
      // Exit code 75 = restart signal (caught by start script loop)
      setTimeout(() => process.exit(75), 500);
    },
  };

  function handleUse(msg, args) {
    const parsed = parseUseArg(args);
    if (!parsed) return msg.reply("usage: `/use <agent>[.pane]` or `/use reset`");

    if (parsed.reset) {
      overrides.delete(msg.channelId);
      const saved = state.get("overrides", {});
      delete saved[msg.channelId];
      state.set("overrides", saved);
      const base = channelMap().get(msg.channelId);
      return msg.reply(base ? `reset to **${base.name}** pane ${base.pane}` : "no yaml mapping for this channel");
    }

    const base = channelMap().get(msg.channelId) || {};
    const mapping = { name: parsed.name, dir: base.dir || "", pane: parsed.pane };
    overrides.set(msg.channelId, mapping);
    const saved = state.get("overrides", {});
    saved[msg.channelId] = mapping;
    state.set("overrides", saved);
    return msg.reply(`switched to **${parsed.name}** pane ${parsed.pane}`);
  }

  const ts = () => new Date().toLocaleTimeString("sv");

  async function hasReadyResponse(mapping, pane, promptText) {
    if (!agent.hasResponseForPrompt) return false;
    try {
      return await agent.hasResponseForPrompt(mapping.name, pane, promptText);
    } catch (err) {
      console.warn(`hasReadyResponse failed for ${mapping.name}:${pane}: ${err.message}`);
      return false;
    }
  }

  function promptForAgent(cleanPrompt) {
    const ttsHint = tts.isEnabled?.() ? "\n[tts on — keep it speakable, skip formatting]" : "";
    return ttsHint ? cleanPrompt + ttsHint : cleanPrompt;
  }

  /**
   * Wait for agent to fully complete (idle 2 polls in a row), then send the result.
   * No streaming - just wait, then send. Avoids all timing/scrollback issues.
   */
  async function streamResponse(msg, mapping, pane, promptText, tmpFiles = []) {
    const startTime = Date.now();
    const maxDuration = 600_000;
    const target = `${mapping.name}:.${pane}`;

    // Wait for completion (idle 2 polls in a row after we saw busy).
    // Echo verification is handled by the retry loop in processMessage.
    let sawWorking = false;
    let idleStreak = 0;
    const workMaxMs = 60_000; // If echo but no busy signal within 60s, fail loud

    while (Date.now() - startTime < maxDuration) {
      const busy = await agent.isBusy(mapping.name, pane, promptText);
      // Dismiss on every tick, not just idle. isBusy can return true
      // indefinitely if prompt-matching fails, so a survey would never
      // get dismissed if we only ran this during idle ticks.
      await agent.dismissBlockingPrompt(target)
        .catch((err) => console.warn(`poll-dismiss failed: ${err.message}`));

      if (busy) { sawWorking = true; idleStreak = 0; }
      else {
        idleStreak += 1;
        if (sawWorking && idleStreak >= 2) break;
        if (!sawWorking && await hasReadyResponse(mapping, pane, promptText)) break;
      }
      if (!sawWorking && Date.now() - startTime > workMaxMs) {
        console.warn(`[${ts()}] ⚠ ${mapping.name}:${pane} prompt not processed within ${workMaxMs}ms`);
        break;
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    // Dismiss any blocking prompts
    await agent.dismissBlockingPrompt(`${mapping.name}:.${pane}`)
      .catch((err) => console.warn(`dismiss failed: ${err.message}`));

    // Get final response - matched to our exact prompt.
    // Use the raw-aware variant when recording so we can persist the exact
    // input to the extract pipeline alongside its output.
    const sent = [];
    let raw = null, turn = null, items, source = null;
    if (rec.enabled) {
      ({ raw, turn, items, source } = await agent.getResponseStreamWithRaw(mapping.name, pane, promptText));
    } else {
      items = await agent.getResponseStream(mapping.name, pane, promptText);
    }

    // Merge all items (text + tool calls) into one message, then split
    // only for Discord's max message size. Tool calls are shown as italic
    // lines inline rather than as separate messages.
    const rawText = items
      .map((item) => item.type === "tool" ? `*${item.content}*` : item.content)
      .join("\n\n");

    // Extract [image: /path] markers. Attach valid paths to first chunk.
    // Invalid markers (missing file, too big, wrong format) get replaced with
    // an inline warning so the user knows the agent tried but failed.
    const { text: cleanedText, paths: imagePaths } = extractImageMarkers(rawText);
    const validFiles = [];
    const failedMarkers = [];
    for (const p of imagePaths) {
      const result = validateImagePath(p, statSync);
      if (result.ok) validFiles.push(result.path);
      else failedMarkers.push(`⚠️ image skipped: \`${p}\` (${result.error})`);
    }
    const fullText = [cleanedText, ...failedMarkers].filter(Boolean).join("\n\n") || "(no text)";

    const chunks = splitMessage(fullText);
    // Pace ANY multi-chunk send: Discord's bot rate limit can drop chunks
    // when sent in tight succession, even at 2-3 messages. The dropped
    // chunk fails silently because we .catch console.warn — looks like
    // truncation to the user. 250ms gap is enough; bumps to 400 on >3
    // because long replies are more likely to hit the 5/5s sliding window.
    const pacePerChunk = chunks.length >= 2 ? (chunks.length > 3 ? 400 : 250) : 0;
    for (let i = 0; i < chunks.length; i++) {
      sent.push(chunks[i]);
      // Attach image files to the first chunk only
      const payload = (i === 0 && validFiles.length)
        ? { content: chunks[i], files: validFiles }
        : chunks[i];
      try {
        await msg.send(payload);
      } catch (err) {
        // Surface the failure visibly so dropped chunks don't masquerade
        // as truncated responses.
        console.warn(`send chunk ${i + 1}/${chunks.length} failed for ${mapping.name}:${pane}: ${err.message}`);
        try {
          await msg.send(`⚠️ chunk ${i + 1}/${chunks.length} failed (${err.message.slice(0, 80)})`);
        } catch { /* even the error-notice failed; give up */ }
      }
      if (pacePerChunk > 0 && i < chunks.length - 1) {
        await new Promise((r) => setTimeout(r, pacePerChunk));
      }
    }

    // Context% at the end
    const context = agent.getContextPercent(mapping.name, pane);
    if (context) {
      const k = Math.round(context.tokens / 1000);
      const contextMsg = `_context: ${context.percent}% (${k}k)_`;
      sent.push(contextMsg);
      await msg.send(contextMsg)
        .catch((err) => console.warn(`send context failed: ${err.message}`));
    }

    // TTS: speak the text parts of the response (skips tool calls)
    if (tts.isEnabled && tts.isEnabled()) {
      const ttsText = items.filter((i) => i.type === "text").map((i) => i.content).join("\n\n");
      if (ttsText) {
        await tts.sendFollowup(msg.send, ttsText, tmpFiles)
          .catch((err) => console.warn(`tts failed: ${err.message}`));
      }
    }

    if (rec.enabled) {
      rec.save({
        ts: new Date().toISOString(),
        agent: mapping.name,
        pane,
        prompt: promptText,
        raw,
        turn,
        items,
        context,
        discordSent: sent,
        durationMs: Date.now() - startTime,
        source,
      });
    }
  }

  async function processMessage(msg, mapping, cleanPrompt, pane, tmpFiles) {
    console.log(`[${ts()}] ← ${mapping.name}:${pane} "${cleanPrompt.slice(0, 80)}"`);
    const stopTyping = msg.startTyping();

    const promptToSend = promptForAgent(cleanPrompt);

    try {
      // Retry loop: dismiss → send → verify echo. If a survey ate the
      // prompt (no echo + agent still idle), dismiss again and resend.
      // isBusy guard prevents double-send when echo detection is just slow.
      const target = `${mapping.name}:.${pane}`;
      const echoTimeout = Math.max(50, Math.min(15_000, pollInterval * 500));
      let delivered = false;

      await withPaneSendLock(`${mapping.name}:${pane}`, async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await agent.dismissBlockingPrompt(target)
            .catch((err) => console.warn(`dismiss attempt ${attempt} failed: ${err.message}`));
          await agent.sendOnly(mapping.name, promptToSend, pane);

          const echoed = await agent.waitForPromptEcho(mapping.name, pane, cleanPrompt, echoTimeout);
          if (echoed) { delivered = true; break; }

          const busy = await agent.isBusy(mapping.name, pane, cleanPrompt);
          if (busy) { delivered = true; break; } // prompt received, echo just slow

          if (attempt < 3) {
            console.warn(`[${ts()}] ⚠ ${mapping.name}:${pane} prompt not echoed (attempt ${attempt}/3), retrying`);
          }
        }
      });

      if (!delivered) {
        console.warn(`[${ts()}] ⚠ ${mapping.name}:${pane} prompt not delivered after 3 attempts`);
        await msg.send("⚠️ Agent did not acknowledge prompt after 3 attempts. Pane may be dead, try `/raw` to inspect.")
          .catch((err) => console.warn(`send warning failed: ${err.message}`));
      } else if (msg.channelId) {
        // Inline channel-topic update mirrors the CLI sendToPane path so
        // Discord-originated prompts land in the topic too. Throttled per
        // channel; failures are non-fatal (tmux already has the prompt).
        import("./cli/send-notify.mjs").then(({ setChannelTopicThrottled }) => {
          const snippet = cleanPrompt.replace(/\s+/g, " ").trim().slice(0, 140);
          const stamp = new Date().toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
          const topic = `[${mapping.name}:p${pane}] "${snippet}" · ${stamp}`;
          return setChannelTopicThrottled(msg.channelId, topic);
        }).then((r) => {
          if (r && !r.updated && r.reason && !r.reason.startsWith("throttled") && !r.reason.startsWith("unchanged")) {
            console.warn(`topic ${mapping.name}:${pane} → ${msg.channelId}: ${r.reason}`);
          }
        }).catch(() => {});
      }

      await streamResponse(msg, mapping, pane, cleanPrompt, tmpFiles);
      console.log(`[${ts()}] → ${mapping.name}:${pane} done`);
    } catch (err) {
      console.log(`[${ts()}] ✗ ${mapping.name}:${pane} ${err.message}`);
      await msg.reply(formatAgentError(err))
        .catch((replyErr) => console.warn(`error reply failed: ${replyErr.message}`));
    } finally {
      stopTyping();
      cleanupTmpFiles(tmpFiles);
    }
  }

  /**
   * Circuit breaker: if this Discord channel has sent N identical short
   * messages within the window, drop the incoming message and (on the
   * first block of the period) post a warning back to the channel.
   *
   * Uses the pane's own target (mapping.pane if no inline .N prefix) for
   * the guard key. Inline `.N` overrides aren't parsed yet at this stage
   * — we'd need the raw text for that, and parsePane runs after
   * attachment processing. For a 0-spam scenario (the case we care about)
   * inline prefixes are not a realistic concern. If we ever need to key
   * on the parsed-pane we can move the guard after parsePane.
   *
   * @returns {boolean} true if the message should NOT be forwarded.
   */
  function handleLoopGuard(msg, mapping) {
    if (!loopGuardConfig.enabled) return false;
    const pane = mapping.pane || 0;
    const key = loopGuardKey(mapping.name, pane);

    const all = state.get("loop_guard", {}) || {};
    const entry = all[key] || { last_msgs: [], last_warning_ts: null };

    // Use the raw msg.text — attachments haven't been expanded yet, but
    // that's fine: short-msg loops are about text like "0", not audio
    // attachments.
    const result = checkLoopGuard(entry, msg.text || "", Date.now(), loopGuardConfig);

    // Persist entry (checkLoopGuard mutated it in place)
    all[key] = entry;
    state.set("loop_guard", all);

    if (!result.block) return false;

    if (result.warn) {
      const line = formatLoopGuardWarning(result);
      msg.reply(line).catch((err) =>
        console.warn(`loop-guard warning reply failed: ${err.message}`));
      console.warn(
        `[${ts()}] ⛔ loop-guard ${key}: blocked '${result.text}' × ${result.count} in ${result.ageSec}s`,
      );
    }
    return true; // block
  }

  /**
   * Post "ℹ N turns since your last Discord sync" if the pane saw
   * activity since the last outbound Discord message for this channel.
   * Silent when count is 0 or when jsonl is unavailable (e.g. post-/clear).
   */
  async function postCatchupNoticeIfNeeded(msg, mapping, pane) {
    try {
      if (!mapping?.dir) return; // mapping is synthetic/unknown, skip
      const mirrorTimes = state.get("channel_last_mirror_ts", {}) || {};
      const lastTs = mirrorTimes[msg.channelId] || null;
      const paneDir = panePathFor({ dir: mapping.dir }, pane);
      const result = countTurnsSince(paneDir, lastTs);
      const countLine = renderCatchupLine(result);
      if (!countLine) return;

      // Append up to 3 preview lines so the reader sees what they missed
      // without having to run amux log. Previews are best-effort — if the
      // jsonl read fails for any reason, we still post the count line.
      const previewLines = collectCatchupPreviewLines(paneDir, lastTs, mapping.name);
      const body = previewLines.length ? `${countLine}\n${previewLines.join("\n")}` : countLine;

      await msg.send(body); // msg.send stamps via onSent → count resets for next msg
    } catch (err) {
      console.warn(`catchup notice failed: ${err.message}`);
    }
  }

  /** Read recent turns and format them into preview lines. Wrapped in its
   *  own try so a preview failure never prevents the count-line from being
   *  posted — the count is more valuable than the preview. */
  function collectCatchupPreviewLines(paneDir, lastTs, agentName) {
    try {
      const since = lastTs ? new Date(lastTs) : null;
      const validSince = since && !Number.isNaN(since.getTime()) ? since : null;
      // Limit is generous (10) because previews are drawn from "turns since
      // lastTs" and we want at least 3 readable turns post-filter. The
      // formatter itself caps output at 3 lines.
      const result = readLastTurns(paneDir, { since: validSince, limit: 10 });
      if (!result || !result.turns.length) return [];
      return formatCatchupPreview(result.turns, { agentName: agentName || "agent" });
    } catch (err) {
      console.warn(`catchup preview failed: ${err.message}`);
      return [];
    }
  }

  async function onMessage(msg) {
    if (msg.isBot) return;
    const mapping = getMapping(msg.channelId);
    if (!mapping) return;

    // Loop guard: check BEFORE any expensive work (attachment download,
    // transcription, state reads, pane writes). A runaway loop would
    // otherwise still bill Whisper + pane tokens on every turn even if
    // we later block forwarding. Gate at the door.
    if (handleLoopGuard(msg, mapping)) return;

    const tmpFiles = [];
    const prompt = await attachments.buildPrompt(msg, tmpFiles);
    if (!prompt) return;

    const { pane: parsedPane, prompt: cleanPrompt } = parsePane(prompt);
    const pane = parsedPane || mapping.pane || 0;
    const parsed = parseCommand(cleanPrompt);

    // Catch-up notice: user returning to a stale Discord channel after
    // activity in the pane (e.g. Mattias typed directly into tmux or
    // another agent drove the pane). Posting the count BEFORE we forward
    // the user's message avoids the confusion of "wait, what just
    // happened in this channel?" The notice itself stamps via onSent so
    // subsequent messages in the same channel won't re-notify.
    await postCatchupNoticeIfNeeded(msg, mapping, pane);

    if (parsed?.cmd === "/use") {
      await handleUse(msg, parsed.args).catch((err) =>
        msg.reply(`error: ${err.message}`).catch((replyErr) =>
          console.warn(`/use error reply failed: ${replyErr.message}`)));
      cleanupTmpFiles(tmpFiles);
      return;
    }

    if (parsed && commands[parsed.cmd]) {
      try {
        await commands[parsed.cmd](msg, mapping, pane, parsed.args);
      } catch (err) {
        await msg.reply(`${parsed.cmd} failed: ${err.message}`).catch((replyErr) =>
          console.warn(`${parsed.cmd} error reply failed: ${replyErr.message}`));
      }
      cleanupTmpFiles(tmpFiles);
      return;
    }

    // Unknown // command → pass through to the current agent as a slash command.
    // Agent internal commands (/compact, /clear, /new, /model etc.)
    // produce no assistant response in jsonl. Sending them through the
    // normal processMessage pipeline would timeout on waitForPromptEcho.
    // agentmux commands (matched above) always take priority.
    if (parsed && !commands[parsed.cmd] && parsed.cmd !== "/use") {
      const claudeCmd = parsed.args ? `${parsed.cmd} ${parsed.args}` : parsed.cmd;
      try {
        await agent.sendOnly(mapping.name, claudeCmd, pane);
        await msg.reply(`sent \`${parsed.cmd}\``);
      } catch (err) {
        await msg.reply(`${parsed.cmd} failed: ${err.message}`).catch(() => {});
      }
      cleanupTmpFiles(tmpFiles);
      return;
    }

    // Follow mode: just inject prompt, follow-loop handles output
    if (followers.has(msg.channelId)) {
      agent.sendOnly(mapping.name, cleanPrompt, pane).catch((err) =>
        console.warn(`follow inject sendOnly failed: ${err.message}`));
      cleanupTmpFiles(tmpFiles);
      return;
    }

    return processMessage(msg, mapping, cleanPrompt, pane, tmpFiles);
  }

  return { onMessage };
}
