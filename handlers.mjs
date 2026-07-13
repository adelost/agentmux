// Message handling: commands, agent routing, reply pipeline.
// Channel-agnostic. Works with any ChannelMessage from channels/*.mjs.

import { splitMessage, parsePane, parseCommand, parseUseArg } from "./lib.mjs";
import { readFileSync } from "fs";
import { executeSync } from "./core/sync-discord.mjs";
import { countTurnsSince, panePathFor, readLastTurns } from "./core/jsonl-reader.mjs";
import { checkLoopGuard, loopGuardKey, formatLoopGuardWarning, readLoopGuardConfig } from "./core/loop-guard.mjs";
import { formatCatchupPreview } from "./core/catchup-format.mjs";
import { shortModelName } from "./core/context.mjs";
import { loadConfig } from "./cli/config.mjs";
import { decideParkedSend, readParkState, unparkPane } from "./core/pane-park.mjs";
import { driveCodexStatus, formatCodexStatus } from "./core/codex-status.mjs";
import { prepareCodexIdle } from "./core/codex-tui.mjs";
import {
  clearCodexModelOverride,
  codexLoginCommand,
  codexModelOverride,
  codexProfileCatalog,
  isCodexProfileAuthenticated,
  prepareCodexProfile,
  resolveCodexProfile,
  selectedCodexProfile,
  setCodexModelOverride,
  setCodexProfile,
} from "./core/codex-profiles.mjs";
import { sendPromptVerified, sendSlashVerified } from "./core/delivery.mjs";
import {
  MODEL_RECOVERY_STATE_KEY, MODEL_RECOVERY_SETTLE_MS, resumeBrief,
} from "./core/model-watch.mjs";
import { queueFleetRestart } from "./core/fleet-restart.mjs";

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
      if (summary && !summary.skipped && (
        summary.added || summary.respawned?.length || summary.removedExtras?.length ||
        summary.mismatches?.length || summary.extras
      )) {
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
  "`/status` — native Codex account, model, context and usage limits",
  "`/switch` — toggle this Codex pane between account profiles 1 and 2",
  "`/model` — show current model; `/model <name>` — switch (fable/opus/sonnet/haiku)",
  "`/restore` — restore the model that was active before the latest downgrade",
  "`/dismiss` — dismiss blocking prompt (survey etc.)",
  "`/esc` — interrupt (send Escape)",
  "`/use <agent>[.pane]` — switch channel target",
  "`/use reset` — back to yaml default",
  "`/thinking` — toggle real-time text streaming (default: on)",
  "`/follow` — toggle: stream output even when typing in tmux",
  "`/tts` — toggle text-to-speech for this channel",
  "`/sync` — create/sync Discord channels from agentmux.yaml",
  "`/reload` — reload agents.yaml",
  "`/restart` — restart agentmux bridge",
  "`/restart all` — recreate every configured tmux session + restart bridge (interrupts active work)",
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
 * Create message handler with all dependencies injected.
 * @param {{ agent, attachments, tts, getMapping, overrides, channelMap, reloadConfig, discordChannel?, agentmuxYamlPath?, agentsYamlPath? }} deps
 */
export function createHandlers({ agent, attachments, tts, state, getMapping, overrides, channelMap, reloadConfig, discordChannel, agentmuxYamlPath, agentsYamlPath, recorder, pollInterval = 2000, loopGuardConfig = readLoopGuardConfig(), codexStatusDriver = driveCodexStatus, queueFleetRestartRequest = queueFleetRestart, scheduleBridgeRestart = (delayMs) => setTimeout(() => process.exit(75), delayMs) }) {
  const noopRecorder = { save: () => {}, enabled: false };
  const rec = recorder || noopRecorder;
  const sendLocks = new Map();
  const followers = new Map(); // channelId → { timer, sentCount, lastHash }
  const parkWarnedSince = new Map(); // "name:pane" → park.sinceMs already warned (two-strike confirm)

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

  function paneCommand(mapping, pane) {
    try { return loadConfig(agentsYamlPath)?.[mapping.name]?.panes?.[pane]?.cmd || ""; }
    catch { return ""; }
  }

  const isCodexPane = (mapping, pane) => /codex/i.test(paneCommand(mapping, pane));

  async function nativeCodexStatus(mapping, pane) {
    return codexStatusDriver({
      agent,
      name: mapping.name,
      pane,
      log: (message) => console.log(`[${ts()}] ${message}`),
    });
  }

  function rememberNativeModel(mapping, pane, status) {
    if (!status?.model?.id) return;
    setCodexModelOverride(state, mapping.name, pane, status.model.id, status.model.effort);
  }

  async function rollbackCodexLaunch(mapping, pane, { profile, model }) {
    // A local human can type while the bridge verifies native status. Never
    // destroy that new draft merely to make rollback automatic; leave the
    // pane on the attempted launch and report the blocked rollback instead.
    const idle = await prepareCodexIdle({ agent, name: mapping.name, pane });
    if (!idle.ok) {
      throw new Error(`blocked to preserve pane input (${idle.stage}: ${idle.error})`);
    }
    setCodexProfile(state, mapping.name, pane, profile.id);
    if (model?.model) setCodexModelOverride(state, mapping.name, pane, model.model, model.effort);
    else clearCodexModelOverride(state, mapping.name, pane);
    await agent.restartCodex(mapping.name, pane, {
      profile,
      model: model?.model || null,
      effort: model?.effort || null,
    });
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
      if (isCodexPane(mapping, pane)) {
        const profile = selectedCodexProfile(state, mapping.name, pane);
        const result = await withPaneSendLock(`${mapping.name}:${pane}`, () =>
          nativeCodexStatus(mapping, pane));
        if (result.ok) {
          rememberNativeModel(mapping, pane, result.status);
          await msg.reply(formatCodexStatus(result.status, {
            agentName: mapping.name,
            pane,
            profile: profile.id,
          }));
          return;
        }
        // Preserve useful local context when Codex is mid-redraw or has a
        // human draft.  Limits/account are deliberately omitted rather than
        // fabricated from amux counters.
        const context = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
        const model = shortModelName(context?.model) || context?.model || "unknown";
        const contextLabel = context
          ? `${context.percent}%${context.tokens != null ? ` (${Math.round(context.tokens / 1000)}k)` : ""}`
          : "unknown";
        await msg.reply(`⚠️ Native Codex-status kunde inte läsas (${result.stage}: ${result.error}).\n` +
          `**${mapping.name}** pane ${pane}${override} · profil ${profile.id} · model: ${model} · context: ${contextLabel}`);
        return;
      }
      const context = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
      const ctxStr = context
        ? `${context.percent}%${context.tokens != null ? ` (${Math.round(context.tokens / 1000)}k)` : ""}`
        : "unknown";
      const modelStr = shortModelName(context?.model);
      const modelPart = modelStr ? ` · model: ${modelStr}` : "";
      await msg.reply(`**${mapping.name}** pane ${pane}${override}${modelPart} · context: ${ctxStr}`);
    },

    "/switch": async (msg, mapping, pane, args) => {
      if (!isCodexPane(mapping, pane)) {
        await msg.reply(`**${mapping.name}:${pane}** är inte en Codex-panel; kontoprofiler gäller bara Codex.`);
        return;
      }
      const catalog = codexProfileCatalog();
      const current = selectedCodexProfile(state, mapping.name, pane, catalog);
      const target = resolveCodexProfile(args, current, catalog);
      if (!target) {
        await msg.reply("okänd Codex-profil — använd `//switch`, `//switch 1` eller `//switch 2`");
        return;
      }

      prepareCodexProfile(target, catalog[0]);
      if (!isCodexProfileAuthenticated(target)) {
        await msg.reply(`Codex-profil **${target.id}** behöver en engångsinloggning. Kör i WSL:\n` +
          `\`${codexLoginCommand(target)}\`\n` +
          "När den är klar fungerar bara `//switch` fram och tillbaka utan logout.");
        return;
      }

      const result = await withPaneSendLock(`${mapping.name}:${pane}`, async () => {
        if (target.id === current.id) {
          const status = await nativeCodexStatus(mapping, pane);
          return { kind: "same", status };
        }

        const idle = await prepareCodexIdle({ agent, name: mapping.name, pane });
        if (!idle.ok) return { kind: "failed", error: `${idle.stage}: ${idle.error}` };

        const previousOverride = codexModelOverride(state, mapping.name, pane);
        const beforeStatus = await nativeCodexStatus(mapping, pane);
        const context = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
        const effective = beforeStatus.ok && beforeStatus.status.model?.id
          ? { model: beforeStatus.status.model.id, effort: beforeStatus.status.model.effort }
          : previousOverride || (context?.model ? { model: context.model, effort: context.effort ?? null } : null);

        setCodexProfile(state, mapping.name, pane, target.id);
        if (effective?.model) setCodexModelOverride(state, mapping.name, pane, effective.model, effective.effort);
        try {
          await agent.restartCodex(mapping.name, pane, {
            profile: target,
            model: effective?.model || null,
            effort: effective?.effort || null,
          });
          const verified = await nativeCodexStatus(mapping, pane);
          if (!verified.ok) throw new Error(`native status: ${verified.stage}: ${verified.error}`);
          if (effective?.model && verified.status.model?.id !== effective.model) {
            throw new Error(`expected ${effective.model}, status shows ${verified.status.model?.id || "unknown"}`);
          }
          rememberNativeModel(mapping, pane, verified.status);
          return { kind: "switched", status: verified };
        } catch (err) {
          let rollbackError = null;
          try {
            await rollbackCodexLaunch(mapping, pane, { profile: current, model: previousOverride || effective });
          } catch (rollback) {
            rollbackError = rollback.message;
          }
          return { kind: "failed", error: err.message, rollbackError };
        }
      });

      if (result.kind === "failed") {
        await msg.reply(`⚠️ Kontobytet avbröts: ${result.error}.` +
          (result.rollbackError ? ` Återställningen misslyckades också: ${result.rollbackError}` : " Föregående profil återställdes."));
        return;
      }
      if (!result.status.ok) {
        await msg.reply(`Profil **${current.id}** är redan aktiv, men native status kunde inte läsas (${result.status.stage}).`);
        return;
      }
      await msg.reply((result.kind === "switched" ? "✅ Konto bytt.\n" : "") +
        formatCodexStatus(result.status.status, {
          agentName: mapping.name,
          pane,
          profile: result.kind === "switched" ? target.id : current.id,
        }));
    },

    // Bare /model reads the pane's current model. Claude receives its native
    // slash command; Codex is restarted+resumed with process-local overrides
    // and then verified against native /status (see the global-config bug
    // rationale below).
    "/model": async (msg, mapping, pane, args) => {
      const name = (args || "").trim();
      const codexPane = isCodexPane(mapping, pane);
      if (!name) {
        const ctx = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
        const current = shortModelName(ctx?.model) || ctx?.model;
        const switchHint = codexPane
          ? "Switch with `//model <name> [low|medium|high|xhigh|max]` — pane-local restart; the global Codex default is untouched"
          : `Switch with \`//model <name>\` (e.g. fable, opus, sonnet, haiku)`;
        await msg.reply(current
          ? `**${mapping.name}** pane ${pane} · model: ${current}\n${switchHint}`
          : "model unknown (no jsonl/statusline data yet)");
        return;
      }
      if (codexPane) {
        // Restart+resume with CLI overrides instead of driving /model. Codex
        // persists TUI selections to CODEX_HOME/config.toml; that old path
        // silently changed every pane. -m/-c apply only to this process and
        // resume the same session, making the Discord command genuinely local.
        const spec = name.match(/^([a-z0-9._-]+)(?:\s+(minimal|low|medium|high|xhigh|max|ultra))?$/i);
        if (!spec) {
          await msg.reply(`invalid codex model spec: \`${name}\` — expected \`<model> [minimal|low|medium|high|xhigh|max|ultra]\``);
          return;
        }
        const [, targetModel, targetEffort] = spec;
        const result = await withPaneSendLock(`${mapping.name}:${pane}`, async () => {
          const idle = await prepareCodexIdle({ agent, name: mapping.name, pane });
          if (!idle.ok) return { ok: false, error: `${idle.stage}: ${idle.error}` };

          const context = await (agent.getContext?.(mapping.name, pane) ?? agent.getContextPercent(mapping.name, pane));
          const previous = codexModelOverride(state, mapping.name, pane)
            || (context?.model ? { model: context.model, effort: context.effort ?? null } : null);
          const effort = targetEffort?.toLowerCase() || previous?.effort || null;
          const profile = selectedCodexProfile(state, mapping.name, pane);
          setCodexModelOverride(state, mapping.name, pane, targetModel, effort);

          try {
            await agent.restartCodex(mapping.name, pane, { profile, model: targetModel, effort });
            const verified = await nativeCodexStatus(mapping, pane);
            if (!verified.ok) throw new Error(`native status: ${verified.stage}: ${verified.error}`);
            const actual = verified.status.model;
            if (actual?.id !== targetModel || (effort && actual?.effort !== effort)) {
              throw new Error(`expected ${targetModel}${effort ? ` ${effort}` : ""}, status shows ${actual?.id || "unknown"}${actual?.effort ? ` ${actual.effort}` : ""}`);
            }
            rememberNativeModel(mapping, pane, verified.status);
            return { ok: true, model: actual.id, effort: actual.effort };
          } catch (err) {
            let rollbackError = null;
            try { await rollbackCodexLaunch(mapping, pane, { profile, model: previous }); }
            catch (rollback) { rollbackError = rollback.message; }
            return { ok: false, error: err.message, rollbackError };
          }
        });
        if (result.ok) {
          if (readParkState(mapping.name, pane)) {
            unparkPane({ session: mapping.name, pane, detail: `explicit model switch: ${result.model} ${result.effort || ""}`.trim() });
          }
          await msg.reply(`✅ model changed to ${result.model}${result.effort ? ` ${result.effort}` : ""} — bara ${mapping.name}:${pane}; global default orörd`);
        } else {
          await msg.reply(`⚠️ modelbyte avbrutet: ${result.error}.` +
            (result.rollbackError ? ` Återställningen misslyckades också: ${result.rollbackError}` : " Föregående modell återställdes."));
        }
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
          sendSlashVerified(agent, mapping.name, pane, `/model ${name}`));
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

    "/restore": async (msg, mapping, pane) => {
      const park = readParkState(mapping.name, pane);
      if (!park) {
        await msg.reply(`${mapping.name}:${pane} är inte parkerad; ingen modell behöver återställas.`);
        return;
      }
      const key = `${mapping.name}:${pane}`;
      const target = (state.get(MODEL_RECOVERY_STATE_KEY, {}) || {})[key];
      if (!target?.targetModel) {
        await msg.reply(`⚠️ Återställningsmålet saknas för ${key}. Panelen förblir parkerad; använd \`//model <modell> <effort>\` explicit.`);
        return;
      }
      const paneCmd = loadConfig(agentsYamlPath)?.[mapping.name]?.panes?.[pane]?.cmd || "";
      if (!/codex/i.test(paneCmd)) {
        await msg.reply(`⚠️ Automatisk \`/restore\` stöder ännu Codex-paneler. ${key} förblir parkerad; använd \`//model ${target.targetModel}\`.`);
        return;
      }
      await msg.reply(`🔁 ${key}: väntar 10 s och försöker återställa ${target.targetModel}${target.targetEffort ? ` ${target.targetEffort}` : ""}. Timeout 60 s.`);
      await new Promise((resolve) => setTimeout(resolve, MODEL_RECOVERY_SETTLE_MS));
      if (await agent.isBusy(mapping.name, pane)) {
        await msg.reply(`🅿 ${key} blev aktiv under väntan och förblir parkerad. Avbryt först och kör \`/restore\` igen.`);
        return;
      }
      const result = await withPaneSendLock(key, async () => {
        const profile = selectedCodexProfile(state, mapping.name, pane);
        const previous = codexModelOverride(state, mapping.name, pane);
        setCodexModelOverride(state, mapping.name, pane, target.targetModel, target.targetEffort || null);
        try {
          await agent.restartCodex(mapping.name, pane, {
            profile,
            model: target.targetModel,
            effort: target.targetEffort || null,
          });
          const verified = await nativeCodexStatus(mapping, pane);
          if (!verified.ok) throw new Error(`${verified.stage}: ${verified.error}`);
          const actual = verified.status.model;
          if (actual?.id !== target.targetModel || (target.targetEffort && actual?.effort !== target.targetEffort)) {
            throw new Error(`status shows ${actual?.id || "unknown"}${actual?.effort ? ` ${actual.effort}` : ""}`);
          }
          rememberNativeModel(mapping, pane, verified.status);
          return { ok: true, model: actual.id, effort: actual.effort };
        } catch (err) {
          try { await rollbackCodexLaunch(mapping, pane, { profile, model: previous }); }
          catch (rollback) { return { ok: false, error: `${err.message}; rollback: ${rollback.message}` }; }
          return { ok: false, error: err.message };
        }
      });
      if (!result.ok) {
        await msg.reply(`🅿 Återställning misslyckades (${result.error}). ${key} förblir parkerad.`);
        return;
      }
      const restored = `${result.model}${result.effort ? ` ${result.effort}` : ""}`;
      unparkPane({ session: mapping.name, pane, detail: `restore verified: ${restored}` });
      await agent.sendOnly(mapping.name, resumeBrief(restored), pane);
      await msg.reply(`✅ ${key} återställd till ${restored}, avparkerad och återstartad med re-verify.`);
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
          if (s.removedExtras?.length) parts.push(`removed idle extras ${s.removedExtras.map((r) => `p${r.pane}`).join(", ")}`);
          if (s.mismatches?.length) parts.push(`mismatched (claude running, not touched): ${s.mismatches.map((m) => `p${m.pane} (${m.has} vs ${m.expected})`).join(", ")}`);
          if (s.extras) parts.push(`${s.extras} active extra pane(s) left untouched`);
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

    "/restart": async (msg, _mapping, _pane, args) => {
      const mode = String(args || "").trim().toLowerCase();
      const fleet = ["all", "tmux", "fleet"].includes(mode);
      if (mode && !fleet) {
        await msg.reply("använd `//restart` för bara bridgen eller `//restart all` för hela tmux-flottan");
        return;
      }
      if (fleet) queueFleetRestartRequest({ source: "discord" });
      await msg.reply(fleet
        ? "helreset köad — alla konfigurerade tmux-sessioner återskapas; aktiva turns avbryts men sparad historik behålls..."
        : "restarting bridge...");
      state.set("restartChannel", msg.channelId);
      // Exit code 75 = restart signal (caught by start script loop)
      scheduleBridgeRestart(500);
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

      const result = await withPaneSendLock(`${mapping.name}:${pane}`, () =>
        sendPromptVerified(agent, mapping.name, pane, promptToSend, {
          verifyText: cleanPrompt,
          attempts: 3,
          echoTimeoutMs: echoTimeout,
          notBeforeMs: msg.createdTimestamp,
          log: (m) => console.warn(`[${ts()}] ⚠ ${mapping.name}:${pane} ${m}`),
        }));
      delivered = result.delivered;
      if (!delivered) {
        const attempts = result.attempts || 1;
        const reason = result.reason ? ` ${result.reason}` : " Pane may be dead or its composer may be stuck.";
        console.warn(`[${ts()}] ⚠ ${mapping.name}:${pane} prompt not delivered after ${attempts} attempt(s)`);
        await msg.send(`⚠️ Agent did not acknowledge prompt after ${attempts} attempt${attempts === 1 ? "" : "s"}.${reason} Try \`/raw\` to inspect.`)
          .catch((err) => console.warn(`send warning failed: ${err.message}`));
      }
      // Topic patching on Discord-inbound prompts was removed: Discord caps
      // channel topic edits at 2/10min/channel, and patching on every prompt
      // burned the budget and hit 429. Topic refresh now happens only on
      // /compact via drift-guard (rare event, safe rate).

      // Reply forwarding handled by channels/jsonl-watcher.mjs.
      console.log(`[${ts()}] → ${mapping.name}:${pane} ${delivered ? "delivered" : "NOT delivered"}`);
      return { delivered };
    } catch (err) {
      console.log(`[${ts()}] ✗ ${mapping.name}:${pane} ${err.message}`);
      await msg.reply(formatAgentError(err))
        .catch((replyErr) => console.warn(`error reply failed: ${replyErr.message}`));
      return { delivered: false, reason: err.message };
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

    // A normal message must not silently wake a pane on a downgraded model, but
    // the human may deliberately want the new model. Two-strike confirm: warn on
    // the first brief, deliver + unpark on an explicit re-send.
    if (!parsed) {
      const park = readParkState(mapping.name, pane);
      const key = `${mapping.name}:${pane}`;
      const decision = decideParkedSend({ park, warnedSinceMs: parkWarnedSince.get(key) ?? null });
      if (decision.action === "warn") {
        parkWarnedSince.set(key, decision.sinceMs);
        await msg.reply(`⚠️ **${mapping.name}:${pane} är parkerad efter modellbyte** (${park.detail}). ` +
          `Meddelandet skickades INTE. Skicka igen för att bekräfta och leverera ändå, eller kör \`/restore\` / \`//model\`.`);
        return;
      }
      if (decision.action === "confirm") {
        parkWarnedSince.delete(key);
        unparkPane({ session: mapping.name, pane, detail: `confirmed by re-send on ${park.detail || "parked model"}` });
        // fall through to normal delivery on the confirmed model
      }
    }

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
          sendSlashVerified(agent, mapping.name, pane, claudeCmd));
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

    // Follow mode changes output handling, not delivery guarantees.
    if (followers.has(msg.channelId)) {
      const result = await withPaneSendLock(`${mapping.name}:${pane}`, () =>
        sendPromptVerified(agent, mapping.name, pane, cleanPrompt, {
          attempts: 3,
          echoTimeoutMs: Math.max(50, Math.min(6_000, pollInterval * 500)),
          notBeforeMs: msg.createdTimestamp,
          log: (m) => console.warn(`follow ${mapping.name}:${pane}: ${m}`),
        }));
      if (!result.delivered) {
        await msg.send(`⚠️ Agent did not acknowledge prompt after ${result.attempts || 1} attempt${result.attempts === 1 ? "" : "s"}. Try \`/raw\` to inspect.`)
          .catch((err) => console.warn(`follow delivery warning failed: ${err.message}`));
      }
      return { delivered: result.delivered };
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
        if (s.removedExtras?.length) parts.push(`removed ${s.removedExtras.length} idle extra(s)`);
        if (s.mismatches?.length) parts.push(`${s.mismatches.length} mismatch(es)`);
        if (s.extras) parts.push(`${s.extras} active extra(s) left alone`);
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
