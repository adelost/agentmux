// Pure helper functions — no side effects, fully testable.

import yaml from "js-yaml";
import { TOOL_CALL, isNoise } from "./core/noise.mjs";
import { stripBullet } from "./core/dialects.mjs";

/** Strip ANSI escape codes from terminal output */
export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");

/**
 * Split text into Discord-safe chunks (max 1900 chars, Discord limit is 2000).
 * Breaks at newlines when possible, hard-cut otherwise.
 *
 * Code-fence aware: if a chunk ends inside an open ```lang block, the chunk
 * gets a closing ``` appended and the next chunk gets a matching ```lang
 * prefix. Without this, Discord renders the middle chunks as markdown text
 * and `__dunder__` becomes **bold**, which eats the underscores. This is
 * exactly what broke the Python Matrix class snippet.
 */
export function splitMessage(text, max = 1900) {
  if (text.length <= max) return [text];

  // Reserve ~20 chars per chunk for injected fence markers (but not on tiny maxes used in tests)
  const effectiveMax = Math.max(1, max > 40 ? max - 20 : max);

  const rawChunks = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= effectiveMax) {
      rawChunks.push(rest);
      break;
    }
    let cut = rest.lastIndexOf("\n", effectiveMax);
    if (cut <= 0) cut = effectiveMax;
    rawChunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }

  // Track open code-fence state across chunks so each chunk is
  // a well-formed Discord message.
  const FENCE = /```(\w*)/g;
  let openLang = null; // null = not in a code block; string = current fence language
  const chunks = [];

  for (const rawChunk of rawChunks) {
    // If we were inside a code block coming into this chunk, prepend opener
    let chunk = openLang !== null ? "```" + openLang + "\n" + rawChunk : rawChunk;

    // Count fences inside this chunk (after any injected opener)
    // to decide whether we end inside an open block.
    const fences = [...chunk.matchAll(FENCE)];
    let insideBlock = openLang !== null;
    let currentLang = openLang;

    // Walk through fences to determine final state
    // Reset and re-walk from the injected-opener perspective
    insideBlock = false;
    currentLang = null;
    // The injected opener (if present) starts at position 0 of chunk
    if (openLang !== null) {
      insideBlock = true;
      currentLang = openLang;
    }
    // Count fence toggles in the *original* rawChunk content to match Discord render
    const rawFences = [...rawChunk.matchAll(FENCE)];
    for (const m of rawFences) {
      if (insideBlock) {
        insideBlock = false;
        currentLang = null;
      } else {
        insideBlock = true;
        currentLang = m[1] || "";
      }
    }

    // If we're still inside a code block at end of chunk, close it
    if (insideBlock) {
      chunk = chunk + "\n```";
      openLang = currentLang;
    } else {
      openLang = null;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/** Escape single quotes for shell: wrap-safe via '\'' technique */
export const esc = (s) => s.replace(/'/g, "'\\''");

/**
 * Parse .env file content into key-value pairs.
 * Strips surrounding quotes. Skips comments and blank lines.
 * Does NOT support inline comments (standard .env behavior).
 */
export function parseEnv(content) {
  const vars = {};
  for (const line of content.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return vars;
}

/**
 * Extract current activity from tmux pane capture.
 * Returns a short description of what the agent is doing, or null.
 * Dialect-agnostic: strips any known bullet glyph.
 */
export function extractActivity(paneContent) {
  const lines = stripAnsi(paneContent).split("\n").map((l) => l.trim()).filter((l) => l && !isNoise(l));
  if (!lines.length) return null;
  const pick = lines.findLast((l) => TOOL_CALL.test(l)) || lines[lines.length - 1];
  const clean = stripBullet(pick);
  return clean.length > 60 ? clean.slice(0, 57) + "…" : clean;
}

/**
 * Parse optional pane prefix from message text.
 * ".1 fix bug" → { pane: 1, prompt: "fix bug" }
 * "fix bug"    → { pane: 0, prompt: "fix bug" }
 */
export function parsePane(text) {
  const m = text.match(/^\.(\d+)\s+([\s\S]+)$/);
  if (m) return { pane: parseInt(m[1], 10), prompt: m[2] };
  return { pane: 0, prompt: text };
}

/** Format seconds to human-readable duration: 30→"30s", 60→"1m", 90→"1m 30s" */
export function formatDuration(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

/**
 * Parse agents.yaml content and build a channel→agent map.
 * Only includes agents that have a `discord` field.
 * Supports two formats:
 *   discord: "channel-id"              → pane 0
 *   discord:
 *     "channel-id-0": 0
 *     "channel-id-1": 1               → per-channel pane
 * Returns Map<channelId, { name, dir, pane }>.
 */
export function buildChannelMap(yamlContent) {
  const doc = yaml.load(yamlContent);
  const map = new Map();
  if (!doc || typeof doc !== "object") return map;
  for (const [name, config] of Object.entries(doc)) {
    if (!config?.discord) continue;
    const dir = config.dir || "";
    if (typeof config.discord === "object") {
      for (const [channelId, pane] of Object.entries(config.discord)) {
        map.set(String(channelId), { name, dir, pane: Number(pane) || 0 });
      }
    } else {
      map.set(String(config.discord), { name, dir, pane: 0 });
    }
  }
  return map;
}

/**
 * Parse a command from message text.
 * Returns { cmd, args } if it starts with /, otherwise null.
 * Works on the prompt AFTER parsePane has stripped the pane prefix.
 */
export function parseCommand(text) {
  const trimmed = text.trim().replace(/^\/\//, "/");
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) return { cmd: trimmed.toLowerCase(), args: "" };
  return { cmd: trimmed.slice(0, spaceIdx).toLowerCase(), args: trimmed.slice(spaceIdx + 1) };
}

/**
 * Parse /use argument into { name, pane } or { reset: true }.
 * Returns null on invalid input.
 *   "reset"   → { reset: true }
 *   "_ai"     → { name: "_ai", pane: 0 }
 *   "_ai.2"   → { name: "_ai", pane: 2 }
 */
export function parseUseArg(arg) {
  const trimmed = arg.trim();
  if (!trimmed) return null;
  if (trimmed === "reset") return { reset: true };
  const m = trimmed.match(/^(\S+?)(?:\.(\d+))?$/);
  if (!m) return null;
  return { name: m[1], pane: m[2] ? parseInt(m[2], 10) : 0 };
}

/**
 * Download a URL to a Buffer.
 */
export async function downloadBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Transcribe audio via Whisper (OpenAI-compatible endpoint).
 * Returns { text: string }.
 */
export async function transcribeAudio(audioBuffer, filename, whisperUrl) {
  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("response_format", "json");

  const res = await fetch(whisperUrl, { method: "POST", body: form });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Whisper ${res.status}: ${body}`);
  }
  return res.json();
}
