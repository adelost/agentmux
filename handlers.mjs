// Message handling: commands, agent routing, reply pipeline.
// Channel-agnostic. Works with any ChannelMessage from channels/*.mjs.

import { splitMessage, parsePane, parseCommand, parseUseArg } from "./lib.mjs";
import { readFileSync } from "fs";
import { executeSync } from "./core/sync-discord.mjs";
import { countTurnsSince, panePathFor, readLastTurns } from "./core/jsonl-reader.mjs";
import { checkLoopGuard, loopGuardKey, formatLoopGuardWarning, readLoopGuardConfig } from "./core/loop-guard.mjs";
import { formatCatchupPreview } from "./core/catchup-format.mjs";
import { shortModelName } from "./core/context.mjs";

/**
 * Reconcile every configured agent's live tmux session against the
 * regenerated config. Per-agent failures are isolated: one broken agent
 * must not stop the others. Only summaries with actual deltas (added
 * panes, respawns, mismatches) are returned so callers' summary lines
 * stay focused on what changed.
 *
 * Exported so the same flow can be tested in isolation and shared
 * between the /sync Discord handler and the CLI-triggered triggerSync.
 *
 * @param {object} agent - agent module with reconcileSession(name)
 * @param {Iterable<string>} agentNames - agents to reconcile, in order
 * @param {(msg: string) => void} [log=console.warn] - per-agent error logger
 * @returns {Promise<object[]>} summaries with at least one delta field set
 */
export async function reconcileAllSessions(agent, agentNames, log = (msg) => console.warn(msg)) {
  const summaries = [];
  for (const name of agentNames) {
    try {
      const summary = await agent.reconcileSession(name);
      if (summary && !summary.skipped && (summary.added || summary.respawned?.length || summary.mismatches?.length || summary.extras)) {
        summaries.push(summary);
      }
    } catch (err) {
      log(`sync: reconcile ${name} failed: ${err.message}`);
    }
  }
  return summaries;
}

// We used to unlink Discord-attachment tmp files after a grace period.
// Removed in 1.16.37: the OS already cleans /tmp via systemd-tmpfiles
// (10d default) and a reboot wipes it entirely. Aggressive cleanup
// risked unlinking files the agent was still reading via Bash —
// we'd rather leak a few MB to /tmp for a few days than lose a PDF
// in the middle of a long agent turn.

const HELP_TEXT = [
  "**Commands:**",
  "`/help` — show this message",
  "`/peek` — last response from agent",
  "`/raw` — last 50 lines of tmux pane (raw)",
  "`/status` — current agent, pane, model, context%",
  "`/model` — show current model; `/model <name>` — switch (fable/opus/sonnet/haiku)",
  "`/dismiss` — dismiss blocking prompt (survey etc.)",
  "`/esc` — interrupt (send Escape)",
  "`/use <agent>[.pane]` — switch channel target",
  "`/use reset` — back to yaml default",
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
  const model = shortModelName(ctx.model);
  const prefix = model ? `${model} · ` : "";
  // tokens can be null when percent came from a custom statusline row
  // (Claude Code's own number) and the jsonl had no usage to display.
  if (ctx.tokens == null) return `\n_${prefix}context: ${ctx.percent}%_`;
  const k = Math.round(ctx.tokens / 1000);
  return `\n_${prefix}context: ${ctx.percent}% (${k}k)_`;
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
 * Deliver a Claude-internal slash command (/model, /compact, /clear, ...)
 * to a pane and VERIFY it was consumed. Slash commands never appear in the
 * session jsonl (no echo verification possible), and typing "/" opens
 * Claude's command palette, which can eat the submitting Enter mid-render —
 * the classic "wrote /model fable in Discord, nothing happened".
 *
 * Verification is terminal-side: if the composer region still shows the
 * command text after a settle, the Enter was eaten → rescue with another
 * Enter (a bare Enter on an empty composer is a no-op, so a false "stuck"
 * read is harmless). Returns { delivered, rescues }; delivered=false means
 * the text likely sits unsubmitted and the caller must NOT claim success.
 */
export async function deliverSlashCommand(agent, agentName, pane, claudeCmd, {
  settleMs = 1200, maxRescues = 2,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const target = `${agentName}:.${pane}`;
  await agent.dismissBlockingPrompt(target).catch(() => {});
  await agent.sendOnly(agentName, claudeCmd, pane);

  for (let attempt = 0; attempt <= maxRescues; attempt++) {
    await sleep(settleMs);
    if (!(await stuckInComposer(agent, agentName, pane, claudeCmd))) {
      return { delivered: true, rescues: attempt };
    }
    if (attempt < maxRescues) await agent.sendEnter(agentName, pane);
  }
  return { delivered: false, rescues: maxRescues };
}

/** The command text still sits in the composer region (last few lines). */
async function stuckInComposer(agent, agentName, pane, claudeCmd) {
  let text = "";
  try {
    text = await agent.capturePane(agentName, pane, 12);
  } catch {
    return false; // pane unreadable: nothing more a rescue-Enter could do
  }
  const needle = claudeCmd.slice(0, 30);
  // Only the tail (composer region): scrollback legitimately echoes the
  // command as transcript output after successful execution.
  return text.split("\n").slice(-4).some((line) => line.includes(needle));
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
            const context = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
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
        const context = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
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
            const context = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
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
      const context = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
      await sendTextReply(msg, text, context);
    },

    "/status": async (msg, mapping, pane) => {
      const override = overrides.has(msg.channelId) ? " (override)" : "";
      const context = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
      const ctxStr = context
        ? `${context.percent}%${context.tokens != null ? ` (${Math.round(context.tokens / 1000)}k)` : ""}`
        : "unknown";
      const modelStr = shortModelName(context?.model);
      const modelPart = modelStr ? ` · model: ${modelStr}` : "";
      await msg.reply(`**${mapping.name}** pane ${pane}${override}${modelPart} · context: ${ctxStr}`);
    },

    // Bare /model replies with the pane's current model (read from the
    // statusline/jsonl — no pane interaction). With an argument it forwards
    // "/model <name>" into the pane so Claude Code itself switches; the
    // change shows on the NEXT assistant turn's footer (jsonl records the
    // model per turn, so instant verification here would read the OLD one).
    "/model": async (msg, mapping, pane, args) => {
      const name = (args || "").trim();
      if (!name) {
        const ctx = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
        const current = shortModelName(ctx?.model) || ctx?.model;
        await msg.reply(current
          ? `**${mapping.name}** pane ${pane} · model: ${current}\nSwitch with \`//model <name>\` (e.g. fable, opus, sonnet, haiku)`
          : "model unknown (no jsonl/statusline data yet)");
        return;
      }
      // Loose whitelist: model ids/aliases only — never arbitrary text into
      // the pane from a typo'd Discord message.
      if (!/^[a-z0-9._\[\]-]+$/i.test(name)) {
        await msg.reply(`invalid model name: \`${name}\``);
        return;
      }
      try {
        const result = await withPaneSendLock(`${mapping.name}:${pane}`, () =>
          deliverSlashCommand(agent, mapping.name, pane, `/model ${name}`));
        if (result.delivered) {
          const rescued = result.rescues ? ` (palette ate Enter, rescued x${result.rescues})` : "";
          await msg.reply(`sent \`/model ${name}\`${rescued} — verify on the next turn's footer (or \`//model\`)`);
        } else {
          await msg.reply(`⚠️ \`/model ${name}\` still sits unsubmitted in the composer — check \`/raw\``);
        }
      } catch (err) {
        await msg.reply(`/model failed: ${err.message}`).catch(() => {});
      }
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
        // is expected, etc). Shared with the CLI-triggered triggerSync path.
        let reconcileSummaries = [];
        try {
          const { parseConfig } = await import("./sync.mjs");
          const cfg = parseConfig(configYaml);
          reconcileSummaries = await reconcileAllSessions(agent, cfg.agents.keys(), (msg) => console.warn(msg));
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

  function promptForAgent(cleanPrompt) {
    // TTS is explicit only. A channel's TTS state must not mutate the
    // prompt sent to the agent; use `amux say "..."` only when the user
    // explicitly asks for spoken output.
    return cleanPrompt;
  }

  // streamResponse and hasReadyResponse were removed in 1.16.32 — agent
  // replies are now mirrored to Discord by channels/jsonl-watcher.mjs,
  // which observes every claude/codex pane's session jsonl directly.
  // processMessage now returns as soon as the prompt is acknowledged
  // (echo or busy-signal); the watcher handles posting the answer.

  async function processMessage(msg, mapping, cleanPrompt, pane, tmpFiles) {
    console.log(`[${ts()}] ← ${mapping.name}:${pane} "${cleanPrompt.slice(0, 80)}"`);
    const stopTyping = msg.startTyping();

    const promptToSend = promptForAgent(cleanPrompt);

    try {
      // Retry loop: dismiss → send → verify echo. If a survey ate the
      // prompt (no echo + agent still idle), dismiss again and resend.
      // isBusy guard prevents double-send when echo detection is just slow.
      const target = `${mapping.name}:.${pane}`;
      // Cap the per-attempt echo wait low: waitForPromptEcho now confirms a
      // queued-but-delivered prompt via the composer tail in ~1s, so this
      // timeout only bites for a genuinely-eaten prompt before we retry.
      // (Was up to 15s, which held the per-pane send-lock that long and
      // delayed the NEXT Discord message to the same pane by 15-26s.)
      const echoTimeout = Math.max(50, Math.min(6_000, pollInterval * 500));
      let delivered = false;

      await withPaneSendLock(`${mapping.name}:${pane}`, async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          await agent.dismissBlockingPrompt(target)
            .catch((err) => console.warn(`dismiss attempt ${attempt} failed: ${err.message}`));
          // A thrown send must NOT abort the retry loop — delivery is judged
          // by the echo check below, not by tmux's exit code. tmux can fail
          // the bridge's one-shot client with errors that aren't ours: a user
          // scrolling the pane fires conf bindings chaining
          // `send-keys -X scroll-*`, and when copy-mode (-e) auto-exits at
          // the bottom mid-chain the leftover -X commands error
          // "not in a mode" — attributed to whichever command client is
          // connected right then. The keys may have landed anyway, so fall
          // through to echo/busy verification and let attempts 2-3 resend.
          await agent.sendOnly(mapping.name, promptToSend, pane)
            .catch((err) => console.warn(`[${ts()}] ⚠ ${mapping.name}:${pane} send attempt ${attempt} errored (verifying echo anyway): ${err.message.split("\n").slice(0, 2).join(" | ")}`));

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
      }
      // Topic patching on Discord-inbound prompts was removed: Discord caps
      // channel topic edits at 2/10min/channel, and patching on every prompt
      // burned the budget and hit 429. Topic refresh now happens only on
      // /compact via drift-guard (rare event, safe rate).

      // Reply forwarding handled by channels/jsonl-watcher.mjs.
      console.log(`[${ts()}] → ${mapping.name}:${pane} delivered`);
    } catch (err) {
      console.log(`[${ts()}] ✗ ${mapping.name}:${pane} ${err.message}`);
      await msg.reply(formatAgentError(err))
        .catch((replyErr) => console.warn(`error reply failed: ${replyErr.message}`));
    } finally {
      stopTyping();
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
    // activity in the pane (e.g. the user typed directly into tmux or
    // another agent drove the pane). Posting the count BEFORE we forward
    // the user's message avoids the confusion of "wait, what just
    // happened in this channel?" The notice itself stamps via onSent so
    // subsequent messages in the same channel won't re-notify.
    await postCatchupNoticeIfNeeded(msg, mapping, pane);

    if (parsed?.cmd === "/use") {
      await handleUse(msg, parsed.args).catch((err) =>
        msg.reply(`error: ${err.message}`).catch((replyErr) =>
          console.warn(`/use error reply failed: ${replyErr.message}`)));
      return;
    }

    if (parsed && commands[parsed.cmd]) {
      try {
        await commands[parsed.cmd](msg, mapping, pane, parsed.args);
      } catch (err) {
        await msg.reply(`${parsed.cmd} failed: ${err.message}`).catch((replyErr) =>
          console.warn(`${parsed.cmd} error reply failed: ${replyErr.message}`));
      }
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
        // Same verified delivery as /model: under the pane's send-lock (no
        // keystroke interleaving with concurrent sends), dismiss first, and
        // rescue a palette-eaten Enter instead of blindly claiming success.
        const result = await withPaneSendLock(`${mapping.name}:${pane}`, () =>
          deliverSlashCommand(agent, mapping.name, pane, claudeCmd));
        if (result.delivered) {
          const rescued = result.rescues ? ` (rescued x${result.rescues})` : "";
          await msg.reply(`sent \`${parsed.cmd}\`${rescued}`);
        } else {
          await msg.reply(`⚠️ \`${parsed.cmd}\` still sits unsubmitted in the composer — check \`/raw\``);
        }
      } catch (err) {
        await msg.reply(`${parsed.cmd} failed: ${err.message}`).catch(() => {});
      }
      return;
    }

    // Follow mode: just inject prompt, follow-loop handles output
    if (followers.has(msg.channelId)) {
      agent.sendOnly(mapping.name, cleanPrompt, pane).catch((err) =>
        console.warn(`follow inject sendOnly failed: ${err.message}`));
      return;
    }

    return processMessage(msg, mapping, cleanPrompt, pane, tmpFiles);
  }

  /**
   * CLI-triggerable sync. Mirrors the /sync Discord handler body but
   * without msg.reply: logs progress to console instead so the trigger
   * works without a Discord context. Used by the SIGUSR1 handler in
   * bot.mjs which the `amux sync` CLI sends to the bridge pid.
   *
   * Returns a result object so the caller can format / forward it.
   */
  async function triggerSync() {
    if (!discordChannel || !agentmuxYamlPath) {
      console.error("sync: not configured (missing agentmux.yaml path or discord channel)");
      return { ok: false, error: "not-configured" };
    }
    if (state.get("syncRunning")) {
      console.warn("sync: already in progress, ignoring trigger");
      return { ok: false, error: "in-progress" };
    }
    state.set("syncRunning", true);
    try {
      console.log("sync: starting (CLI-triggered)");
      const configYaml = readFileSync(agentmuxYamlPath, "utf-8");
      const { parseConfig } = await import("./sync.mjs");
      const { guild: guildId } = parseConfig(configYaml);
      const guild = await discordChannel.getGuild(guildId);
      const results = await executeSync({ guild, configYaml, state, agentsYamlPath });
      reloadConfig();

      // Reconcile live tmux sessions against the freshly-regenerated config.
      // Mirrors /sync Discord handler: changes to agentmux.yaml `panes` (e.g.
      // adding `codex: 2`) need split-window calls to materialize the new
      // tmux panes; without this, agents.yaml lists them but tmux is empty
      // until the next ensureReady call (which only fires on first message).
      const reconcileSummaries = await reconcileAllSessions(agent, parseConfig(configYaml).agents.keys());

      const summary = [];
      if (results.created.length) summary.push(`created: ${results.created.join(", ")}`);
      if (results.renamed?.length) summary.push(`renamed: ${results.renamed.join(", ")}`);
      if (results.existing.length) summary.push(`existing: ${results.existing.length} already-correct`);
      if (results.orphaned.length) summary.push(`orphaned (not deleted): ${results.orphaned.join(", ")}`);
      const total = results.created.length + (results.renamed?.length || 0) + results.existing.length;
      summary.push(`${total} channel(s) synced`);
      for (const s of reconcileSummaries) {
        const parts = [];
        if (s.added) parts.push(`+${s.added} pane(s)`);
        if (s.respawned.length) parts.push(`respawned ${s.respawned.length}`);
        if (s.mismatches?.length) parts.push(`${s.mismatches.length} mismatch(es)`);
        if (parts.length) summary.push(`${s.name}: ${parts.join(", ")}`);
      }
      console.log(`sync done. ${summary.join(" | ")}`);

      // New channels = new panes added to agents.yaml. SIGHUP reloads
      // the inbound channel map but jsonl-watcher initializes its
      // fs.watchers at startup from agents.yaml, so without a restart
      // the new panes' replies go silent on Discord. SIGUSR2 routes
      // through bot.mjs's existing handler (clears restartChannel state
      // → exit 75 → start.sh respawns). Persistent watcher state covers
      // the ~3s downtime. Renaming an existing channel doesn't change
      // pane structure → no restart needed for that path.
      if (results.created.length > 0) {
        console.log("sync: new panes added, restarting bridge (SIGUSR2)");
        process.kill(process.pid, "SIGUSR2");
      }

      return { ok: true, results, summary, reconcileSummaries };
    } catch (err) {
      console.error(`sync failed: ${err.message}`);
      return { ok: false, error: err.message };
    } finally {
      state.set("syncRunning", false);
    }
  }


  return { onMessage, triggerSync };
}
