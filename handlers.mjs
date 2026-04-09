// Message handling: commands, agent routing, reply pipeline.
// Channel-agnostic — works with any ChannelMessage from channels/*.mjs.

import { splitMessage, parsePane, parseCommand, parseUseArg } from "./lib.mjs";
import { readFileSync, unlinkSync } from "fs";
import { executeSync } from "./core/sync-discord.mjs";

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
  "`/thinking` — toggle real-time text streaming (default: on)",
  "`/follow` — toggle: stream output even when typing in tmux",
  "`/tts` — toggle text-to-speech for this channel",
  "`/sync` — create/sync Discord channels from agentus.yaml",
  "`/reload` — reload agents.yaml",
  "`/restart` — restart Agentus",
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
  return (async () => {
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await msg.reply(isLast ? chunks[i] + ctxSuffix : chunks[i]);
    }
  })();
}

/**
 * Create message handler with all dependencies injected.
 * @param {{ agent, attachments, tts, getMapping, overrides, channelMap, reloadConfig, discordChannel?, agentusYamlPath?, agentsYamlPath? }} deps
 */
export function createHandlers({ agent, attachments, tts, state, getMapping, overrides, channelMap, reloadConfig, discordChannel, agentusYamlPath, agentsYamlPath, recorder, pollInterval = 2000 }) {
  const noopRecorder = { save: () => {}, enabled: false };
  const rec = recorder || noopRecorder;
  const queues = new Map();
  const followers = new Map(); // channelId → { timer, sentCount, lastHash }

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
        const segments = await agent.getResponseSegments(mapping.name, pane);
        if (segments.length > 1 && sentCount < segments.length - 1) {
          while (sentCount < segments.length - 1) {
            await msg.send(segments[sentCount]).catch((err) =>
              console.warn(`follow: send segment failed: ${err.message}`));
            sentCount++;
          }
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
      // Agent is working — follow with streaming until idle
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

    "/sync": async (msg) => {
      if (!discordChannel || !agentusYamlPath) {
        await msg.reply("sync not configured (missing agentus.yaml path or discord channel)");
        return;
      }
      if (state.get("syncRunning")) {
        await msg.reply("sync already in progress");
        return;
      }
      state.set("syncRunning", true);
      try {
        await msg.reply("syncing...");
        const configYaml = readFileSync(agentusYamlPath, "utf-8");
        const { guild: guildId } = await import("./sync.mjs").then((m) => m.parseAgentusConfig(configYaml));
        const guild = await discordChannel.getGuild(guildId);
        const results = await executeSync({ guild, configYaml, state, agentsYamlPath });
        reloadConfig();

        const lines = [];
        if (results.created.length) lines.push(`**created:** ${results.created.join(", ")}`);
        if (results.existing.length) lines.push(`**existing:** ${results.existing.join(", ")}`);
        if (results.orphaned.length) lines.push(`**orphaned (not deleted):** ${results.orphaned.join(", ")}`);
        lines.push(`${results.created.length + results.existing.length} channel(s) synced`);
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

  /**
   * Wait for agent to fully complete (idle 2 polls in a row), then send the result.
   * No streaming - just wait, then send. Avoids all timing/scrollback issues.
   */
  async function streamResponse(msg, mapping, pane, promptText, tmpFiles = []) {
    const startTime = Date.now();
    const maxDuration = 600_000;

    // Step 1: Confirm the agent received our prompt by waiting until it's
    // echoed back in the buffer. Positive signal, no hope-and-wait timing.
    // Test envs scale timeouts down via pollInterval.
    //
    // 45s cap (was 15s) covers claude's /compact pause: 15-25s of no
    // jsonl writes while compaction runs and a fresh session file is
    // created. 15s was tight enough to false-fail on /compact turns.
    const echoTimeout = Math.max(100, Math.min(45_000, pollInterval * 7500));
    const echoed = await agent.waitForPromptEcho(mapping.name, pane, promptText, echoTimeout);
    if (!echoed) {
      console.warn(`[${ts()}] ⚠ ${mapping.name}:${pane} prompt not echoed within ${echoTimeout}ms`);
      await msg.send(`⚠️ Agent did not acknowledge prompt within ${Math.round(echoTimeout / 1000)}s. Pane may be dead — try \`/raw\` to inspect.`)
        .catch((err) => console.warn(`send warning failed: ${err.message}`));
      return;
    }

    // Step 2: Wait for completion (idle 2 polls in a row after we saw busy).
    // Since echo is confirmed, we can safely require sawWorking — no more
    // silent fallback on "maybe the agent was just fast".
    let sawWorking = false;
    let idleStreak = 0;
    const workMaxMs = 60_000; // If echo but no busy signal within 60s, fail loud

    while (Date.now() - startTime < maxDuration) {
      const busy = await agent.isBusy(mapping.name, pane, promptText);
      if (busy) { sawWorking = true; idleStreak = 0; }
      else {
        idleStreak += 1;
        if (sawWorking && idleStreak >= 2) break;
      }
      // Fail-loud escape: echo confirmed but agent never went busy within 60s.
      // Extract whatever is there and warn — this usually means the agent is
      // stuck in a UI mode (e.g. permission dialog) we didn't detect.
      if (!sawWorking && Date.now() - startTime > workMaxMs) {
        console.warn(`[${ts()}] ⚠ ${mapping.name}:${pane} echoed prompt but never signaled busy within ${workMaxMs}ms`);
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

    // Collect all chunks first so we know whether to pace. Discord's
    // per-channel bot rate limit is 5 messages per 5s; bursting a long
    // response through splitMessage can trip it. discord.js retries on
    // 429 automatically but the retry backoff spams logs and ruins the
    // streaming feel. Adding a small gap between chunks once we're
    // beyond the safe burst keeps us well under the limit.
    const chunks = [];
    for (const item of items) {
      const formatted = item.type === "tool" ? `*${item.content}*` : item.content;
      for (const chunk of splitMessage(formatted)) chunks.push(chunk);
    }
    const pacePerChunk = chunks.length > 3 ? 400 : 0;
    for (let i = 0; i < chunks.length; i++) {
      sent.push(chunks[i]);
      await msg.send(chunks[i])
        .catch((err) => console.warn(`send failed for ${mapping.name}:${pane}: ${err.message}`));
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

    try {
      await agent.sendOnly(mapping.name, cleanPrompt, pane);
      await streamResponse(msg, mapping, pane, cleanPrompt, tmpFiles);
      console.log(`[${ts()}] → ${mapping.name}:${pane} done`);
    } catch (err) {
      console.log(`[${ts()}] ✗ ${mapping.name}:${pane} ${err.message}`);
      const errMsg = err.killed ? "Timeout" : `${err.stderr || err.message}`;
      await msg.reply(errMsg)
        .catch((replyErr) => console.warn(`error reply failed: ${replyErr.message}`));
    } finally {
      stopTyping();
      cleanupTmpFiles(tmpFiles);
    }
  }

  async function onMessage(msg) {
    if (msg.isBot) return;
    const mapping = getMapping(msg.channelId);
    if (!mapping) return;

    const tmpFiles = [];
    const prompt = await attachments.buildPrompt(msg, tmpFiles);
    if (!prompt) return;

    const { pane: parsedPane, prompt: cleanPrompt } = parsePane(prompt);
    const pane = parsedPane || mapping.pane || 0;
    const parsed = parseCommand(cleanPrompt);

    if (parsed?.cmd === "/use") {
      await handleUse(msg, parsed.args).catch((err) =>
        msg.reply(`error: ${err.message}`).catch((replyErr) =>
          console.warn(`/use error reply failed: ${replyErr.message}`)));
      cleanupTmpFiles(tmpFiles);
      return;
    }

    if (parsed && commands[parsed.cmd]) {
      try {
        await commands[parsed.cmd](msg, mapping, pane);
      } catch (err) {
        await msg.reply(`${parsed.cmd} failed: ${err.message}`).catch((replyErr) =>
          console.warn(`${parsed.cmd} error reply failed: ${replyErr.message}`));
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

    const queueKey = `${mapping.name}:${pane}`;
    const active = queues.get(queueKey);

    if (active) {
      // Agent already processing — inject message directly (no wait)
      agent.sendOnly(mapping.name, cleanPrompt, pane).catch((err) =>
        console.warn(`queue inject sendOnly failed: ${err.message}`));
      cleanupTmpFiles(tmpFiles);
      return;
    }

    const job = processMessage(msg, mapping, cleanPrompt, pane, tmpFiles)
      .finally(() => queues.delete(queueKey));
    queues.set(queueKey, job);
    return job;
  }

  return { onMessage };
}
