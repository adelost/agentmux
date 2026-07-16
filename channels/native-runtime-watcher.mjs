// Mirrors completed native-runtime turns to the same Discord channels used by
// the legacy JSONL watcher. Runtime operation keys and content hashes make the
// projection restart-safe without pretending terminal files are authoritative.

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { loadConfig, channelForPane } from "../cli/config.mjs";
import {
  chunkAttachments,
  extractImageMarkers,
  splitMessage,
  validateImagePath,
} from "../lib.mjs";
import { shortModelName } from "../core/context.mjs";
import { changeMessage } from "../core/model-watch.mjs";
import { parkPane, unparkPane } from "../core/pane-park.mjs";
import { notifyUser } from "../cli/send-notify.mjs";

const STATE_KEY = "native_watcher_posted_turns";
const MODEL_STATE_KEY = "native_watcher_posted_model_changes";
const DEFAULT_POLL_MS = 1_000;
const MAX_POSTED_PER_CHANNEL = 500;

const textContent = (content) => (Array.isArray(content) ? content : [])
  .filter((item) => typeof item?.text === "string"
    && ["text", "input_text", "output_text"].includes(item.type))
  .map((item) => item.text)
  .join("\n");

function toolLabel(block) {
  const name = String(block?.name || "tool");
  const input = block?.input || {};
  if (/^(bash|exec|exec_command)$/i.test(name)) return `Run ${input.command || input.cmd || "command"}`;
  if (/^(read|read_file)$/i.test(name)) return `Read ${input.file_path || input.path || "file"}`;
  if (/^(edit|write|apply_patch)$/i.test(name)) return `Edit ${input.file_path || input.path || "file"}`;
  return name.replace(/^mcp__[^_]+__/, "").replaceAll("_", " ");
}

function eventItems(event) {
  const content = Array.isArray(event?.message?.content) ? event.message.content : [];
  const items = [];
  for (const block of content) {
    if (typeof block?.text === "string"
        && ["text", "input_text", "output_text"].includes(block.type)
        && block.text.trim()) {
      items.push({ type: "text", content: block.text.trim() });
    } else if (block?.type === "tool_use") {
      items.push({ type: "tool", content: toolLabel(block) });
    }
  }
  return items;
}

function turnId(turn) {
  if (turn.operationKey) return `operation:${turn.operationKey}`;
  const payload = JSON.stringify({
    userAt: turn.userAt,
    user: turn.user,
    items: turn.items,
    endAt: turn.endAt,
  });
  return `history:${createHash("sha256").update(payload).digest("hex")}`;
}

export function groupNativeTurns(events = [], { includeEmpty = false } = {}) {
  const turns = [];
  let current = null;
  for (const event of events) {
    if (event?.type === "web" && event.subtype === "user") {
      current = {
        operationKey: event.operationKey || null,
        user: event.text || "",
        userAt: Number(event.at || 0),
        items: [],
        endAt: null,
      };
      turns.push(current);
      continue;
    }
    if (!current) continue;
    if (event?.type === "assistant") current.items.push(...eventItems(event));
    if (event?.type === "web" && event.subtype === "turn-done") {
      if (event.operationKey && !current.operationKey) current.operationKey = event.operationKey;
      current.endAt = Number(event.at || Date.now());
      current.complete = true;
      current.interrupted = Boolean(event.interrupted);
      current.code = event.code;
      current.error = event.error || event.stderr || null;
      current.permissionDenied = Boolean(event.permissionDenied);
      if (!current.items.length && Number(event.code) !== 0) {
        const reason = String(current.error || `native turn failed (${event.code})`).trim();
        current.items.push({
          type: "text",
          content: `${current.permissionDenied ? "🔒 Behörighet nekad" : "⚠️ Native-turn misslyckades"}: ${reason}`,
        });
      }
      current = null;
    }
  }
  return turns.filter((turn) => turn.complete && (includeEmpty || turn.items.length > 0))
    .map((turn) => ({ ...turn, id: turnId(turn) }));
}

// Translate the native runtime's engine-neutral history into the row shape
// consumed by `amux done`. Keeping this projection beside groupNativeTurns
// makes the orchestrator read the same completed-turn boundary as Discord.
export function nativeHistoryRows(agent, pane, events = [], { sinceMs = -Infinity } = {}) {
  const rows = [];
  for (const turn of groupNativeTurns(events)) {
    if (!Number.isFinite(turn.endAt) || turn.endAt < sinceMs) continue;
    const userAt = Number.isFinite(turn.userAt) && turn.userAt > 0 ? turn.userAt : turn.endAt;
    rows.push({
      agent,
      pane,
      timestamp: new Date(userAt).toISOString(),
      role: "user",
      type: "text",
      content: turn.user,
    });
    for (const item of turn.items) {
      rows.push({
        agent,
        pane,
        timestamp: new Date(turn.endAt).toISOString(),
        role: "assistant",
        type: item.type === "tool" ? "tool" : "text",
        content: item.content,
      });
    }
  }
  return rows;
}

function renderTurn(turn) {
  const raw = turn.items
    .map((item) => item.type === "tool" ? `\`${item.content}\`` : item.content)
    .join("\n\n")
    .trim();
  const { text, paths } = extractImageMarkers(raw);
  const files = [];
  const failures = [];
  for (const path of paths) {
    const checked = validateImagePath(path, statSync);
    if (checked.ok) files.push(checked.path);
    else failures.push(`⚠️ image skipped: \`${path}\` (${checked.error})`);
  }
  return {
    text: [text, ...failures].filter(Boolean).join("\n\n"),
    files,
  };
}

export function createNativeRuntimeWatcher({
  nativeRuntime,
  agentsYamlPath,
  discord,
  state,
  notify = notifyUser,
  park = parkPane,
  unpark = unparkPane,
  pollMs = DEFAULT_POLL_MS,
  log = (message) => console.log(`${new Date().toISOString().slice(11, 19)} native-watcher | ${message}`),
} = {}) {
  if (!nativeRuntime) throw new Error("native watcher requires runtime client");
  if (!agentsYamlPath) throw new Error("native watcher requires agentsYamlPath");
  if (!discord) throw new Error("native watcher requires discord");
  if (!state) throw new Error("native watcher requires state");
  let timer = null;
  let stopped = false;
  let ticking = false;
  const lastError = new Map();

  function posted(channelId) {
    const all = state.get(STATE_KEY, {}) || {};
    return Array.isArray(all[channelId]) ? all[channelId] : [];
  }

  function remember(channelId, id) {
    const all = state.get(STATE_KEY, {}) || {};
    const ids = Array.isArray(all[channelId]) ? all[channelId] : [];
    all[channelId] = [...ids.filter((value) => value !== id), id].slice(-MAX_POSTED_PER_CHANNEL);
    state.set(STATE_KEY, all);
  }

  function postedModelChanges(channelId) {
    const all = state.get(MODEL_STATE_KEY, {}) || {};
    return Array.isArray(all[channelId]) ? all[channelId] : [];
  }

  function rememberModelChange(channelId, id) {
    const all = state.get(MODEL_STATE_KEY, {}) || {};
    const ids = Array.isArray(all[channelId]) ? all[channelId] : [];
    all[channelId] = [...ids.filter((value) => value !== id), id].slice(-MAX_POSTED_PER_CHANNEL);
    state.set(MODEL_STATE_KEY, all);
  }

  async function sendModelChanges(name, pane, channelId, events) {
    const seen = new Set(postedModelChanges(channelId));
    for (const event of events.filter((candidate) => candidate?.type === "web"
      && (candidate.subtype === "model-change"
        || (candidate.subtype === "settings" && candidate.clearedModelGuard)))) {
      const id = event.webId || `model:${createHash("sha256").update(JSON.stringify({
        at: event.at,
        from: event.from,
        to: event.to,
        source: event.source,
      })).digest("hex")}`;
      if (seen.has(id)) continue;
      const paneName = `${name}:${pane}`;
      if (event.subtype === "settings") {
        unpark({ session: name, pane, detail: `explicit native model switch: ${event.model}` });
        rememberModelChange(channelId, id);
        seen.add(id);
        log(`${paneName} model guard cleared by explicit setting: ${event.model}`);
        continue;
      }
      if (event.policy === "stop" && !event.expected) {
        park({ session: name, pane, detail: `${event.from} → ${event.to}` });
      } else if (event.kind === "model" && (event.expected || event.direction === "upgrade")) {
        unpark({ session: name, pane, detail: `${event.from} → ${event.to}` });
      }
      await discord.send(channelId, changeMessage(paneName, event, null))
        .catch((error) => log(`${paneName} model-change warning failed: ${error.message}`));
      if (event.policy === "stop" && !event.expected) {
        try {
          await notify(`🔀 ${paneName} nedgraderad och STOPPAD: ${event.from} → ${event.to} — byt modell när läget är rätt`);
        } catch (error) {
          log(`${paneName} model-change push failed: ${error.message}`);
        }
      }
      rememberModelChange(channelId, id);
      seen.add(id);
      log(`${paneName} model change: ${event.from} → ${event.to} (${event.cause || "observed"})`);
    }
  }

  async function sendTurn(channelId, turn, agent) {
    const rendered = renderTurn(turn);
    const chunks = splitMessage(rendered.text || "(no text)");
    const groups = chunkAttachments(rendered.files);
    for (let index = 0; index < chunks.length; index += 1) {
      const payload = index === 0 && groups.length
        ? { content: chunks[index], files: groups[0] }
        : chunks[index];
      await discord.send(channelId, payload);
    }
    for (let index = 1; index < groups.length; index += 1) {
      await discord.send(channelId, { files: groups[index] });
    }
    const context = agent.context;
    if (Number.isFinite(context?.percent)) {
      const model = shortModelName(agent.observedModel || agent.model);
      const modelLabel = [model, agent.observedEffort || agent.effort].filter(Boolean).join(" ");
      const tokens = Number.isFinite(context.usedTokens)
        ? ` (${Math.round(context.usedTokens / 1_000)}k)`
        : "";
      await discord.send(
        channelId,
        `_${modelLabel ? `${modelLabel} · ` : ""}context: ${Math.round(context.percent)}%${tokens}_`,
      );
    }
  }

  async function check(name, pane, entry, sharedConfig = null) {
    const config = sharedConfig || loadConfig(agentsYamlPath);
    const channelId = channelForPane(config, name, pane);
    if (!channelId) return;
    const snapshot = await nativeRuntime.history(name, pane);
    if (snapshot.agent.running && typeof discord.sendTyping === "function") {
      await discord.sendTyping(channelId).catch(() => {});
    }
    await sendModelChanges(name, pane, channelId, snapshot.events);
    const seen = new Set(posted(channelId));
    // Remember terminal operations even when the live stream had no assistant
    // item (common for an interrupt). Otherwise restart hydration can discover
    // partial JSONL text later and mirror an already-finished old turn.
    const turns = groupNativeTurns(snapshot.events, { includeEmpty: true });
    for (const turn of turns.slice(-20)) {
      if (seen.has(turn.id)) continue;
      if (turn.items.length) await sendTurn(channelId, turn, snapshot.agent);
      remember(channelId, turn.id);
      seen.add(turn.id);
      log(`${name}:${pane} → ${channelId} (${turn.id})`);
    }
    lastError.delete(`${name}:${pane}`);
  }

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const config = loadConfig(agentsYamlPath);
      for (const [name, entry] of Object.entries(config || {})) {
        if (entry?.backend !== "native" || !Array.isArray(entry.panes)) continue;
        for (let pane = 0; pane < entry.panes.length; pane += 1) {
          try {
            await check(name, pane, entry, config);
          } catch (error) {
            const key = `${name}:${pane}`;
            if (lastError.get(key) !== error.message) {
              lastError.set(key, error.message);
              log(`${key}: ${error.message}`);
            }
          }
        }
      }
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer) return;
      stopped = false;
      void tick();
      timer = setInterval(() => void tick(), pollMs);
      timer.unref?.();
      log(`enabled | poll=${pollMs}ms`);
    },
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
    check,
  };
}
