// Message handling: commands, agent routing, reply pipeline.
// Channel-agnostic — works with any ChannelMessage from channels/*.mjs.

import { splitMessage, parsePane, parseCommand, parseUseArg } from "./lib.mjs";
import { unlinkSync } from "fs";

function cleanupTmpFiles(files) {
  for (const f of files) {
    try { unlinkSync(f); } catch {}
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
  "`/reload` — reload agents.yaml",
  "`/restart` — restart Agentus",
  "",
  "Prefix with `.N` to target pane N (e.g. `.1 /raw`)",
].join("\n");

function sendTextReply(msg, text, context) {
  const chunks = splitMessage(text);
  const ctxSuffix = context != null ? `\n_context: ${context}%_` : "";
  return (async () => {
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await msg.reply(isLast ? chunks[i] + ctxSuffix : chunks[i]);
    }
  })();
}

/**
 * Create message handler with all dependencies injected.
 * @param {{ agent, attachments, tts, getMapping, overrides, channelMap, reloadConfig }} deps
 */
export function createHandlers({ agent, attachments, tts, state, getMapping, overrides, channelMap, reloadConfig }) {
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
            const context = agent.getContextPercent(mapping.dir);
            const ctxSuffix = context != null ? `\n_context: ${context}%_` : "";
            for (const chunk of splitMessage(text + ctxSuffix)) {
              await msg.send(chunk).catch(() => {});
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
            await msg.send(segments[sentCount]).catch(() => {});
            sentCount++;
          }
        }
      } catch {}
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
        const context = agent.getContextPercent(mapping.dir);
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
            const context = agent.getContextPercent(mapping.dir);
            if (text) await sendTextReply(msg, text, context);
            else if (context != null) await msg.reply(`_context: ${context}%_`);
            resolve();
          } catch { clearInterval(check); clearInterval(progress.timer); resolve(); }
        }, 3000);
      });
    },

    "/raw": async (msg, mapping, pane) => {
      const text = await agent.capturePane(mapping.name, pane);
      const context = agent.getContextPercent(mapping.dir);
      await sendTextReply(msg, text, context);
    },

    "/status": async (msg, mapping, pane) => {
      const override = overrides.has(msg.channelId) ? " (override)" : "";
      const context = agent.getContextPercent(mapping.dir);
      const ctxStr = context != null ? `${context}%` : "unknown";
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

  async function processMessage(msg, mapping, cleanPrompt, pane, tmpFiles) {
    const stopTyping = msg.startTyping();
    const streaming = state.get("thinking", true);
    const progress = agent.startProgressTimer(msg.send, mapping.name, pane, { streaming });

    try {
      await agent.sendAndWait(mapping.name, cleanPrompt, pane);
      const context = agent.getContextPercent(mapping.dir);
      const segments = await agent.getResponseSegments(mapping.name, pane);
      const unsent = segments.slice(progress.sentCount());
      const text = unsent.join("\n\n").trim() || segments.join("\n\n").trim() || "(empty response)";

      await sendTextReply(msg, text, context);
      await tts.sendFollowup(msg.send, text, tmpFiles);
    } catch (err) {
      const errMsg = err.killed ? "Timeout" : `${err.stderr || err.message}`;
      await msg.reply(errMsg).catch(() => {});
    } finally {
      stopTyping();
      clearInterval(progress.timer);
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
      await handleUse(msg, parsed.args).catch((err) => msg.reply(`error: ${err.message}`).catch(() => {}));
      cleanupTmpFiles(tmpFiles);
      return;
    }

    if (parsed && commands[parsed.cmd]) {
      try {
        await commands[parsed.cmd](msg, mapping, pane);
      } catch (err) {
        await msg.reply(`${parsed.cmd} failed: ${err.message}`).catch(() => {});
      }
      cleanupTmpFiles(tmpFiles);
      return;
    }

    // Follow mode: just inject prompt, follow-loop handles output
    if (followers.has(msg.channelId)) {
      agent.sendOnly(mapping.name, cleanPrompt, pane).catch(() => {});
      cleanupTmpFiles(tmpFiles);
      return;
    }

    const queueKey = `${mapping.name}:${pane}`;
    const active = queues.get(queueKey);

    if (active) {
      // Agent already processing — inject message directly (no wait)
      agent.sendOnly(mapping.name, cleanPrompt, pane).catch(() => {});
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
