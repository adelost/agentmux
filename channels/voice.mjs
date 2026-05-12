// Voice PWA HTTP endpoint for car-friendly in-car use.
//
// Exposes a small HTTP surface that a Tailscale-tunneled PWA can hit:
//
//   GET  /api/agents                      list agents + panes + labels
//   POST /api/send/:agent/:pane           push text or audio to a pane
//                                         (audio path transcribes, prefixes
//                                         disclaimer, then feeds the pane)
//   GET  /api/events/:agent/:pane         SSE stream: status + response text
//   POST /api/tts                         text → MP3 audio (edge-tts)
//
// Auth: none. Backend binds 127.0.0.1 by default; tailnet exposure goes via
// Tailscale Serve so the network IS the auth boundary. Same-origin static
// PWA bundle ships from this server too.

import http from "http";
import { writeFileSync, unlinkSync, readFileSync, existsSync, statSync } from "fs";
import { randomBytes } from "crypto";
import { join, resolve, extname } from "path";
import yaml from "js-yaml";
import { esc } from "../lib.mjs";

// Minimal mime map for the static PWA bundle. Anything not listed gets
// application/octet-stream (browsers handle it; this is only for the
// types our SvelteKit build actually emits).
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const DEFAULT_POLL_INTERVAL_MS = 1500;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25 MB (matches OpenAI Whisper limit)
const TRANSCRIPT_PREFIX = "[transcribed voice, may contain speech-to-text errors — interpret intent]";

/**
 * Create (but don't start) the Voice PWA HTTP server.
 *
 * @param {object} deps
 * @param {number} deps.port                      TCP port to bind
 * @param {string} deps.host                      interface to bind (default 127.0.0.1)
 * @param {object} deps.agent                     createAgent() instance
 * @param {string} deps.agentsYamlPath            path to agents.yaml (generated)
 * @param {string} deps.transcribeScript          abs path to whisper wrapper
 * @param {Function} deps.run                     promisified exec(cmd, ms)
 * @param {string} [deps.ttsVoice]                edge-tts voice id
 * @param {object} [deps.mirror]                  { send(channelId, text) } to mirror voice input to Discord
 *                                                 (so channel watchers see what arrived via PWA)
 *
 * @returns {{ start: () => Promise<{url}>, stop: () => Promise<void>, _handler: Function }}
 *   _handler is exposed for tests that wire their own http.Server.
 */
export function createVoicePWA(deps) {
  const {
    port = 8080,
    host = "127.0.0.1",
    agent,
    agentsYamlPath,
    transcribeScript,
    run,
    ttsVoice = "sv-SE-MattiasNeural",
    mirror = null,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    staticDir = null,
  } = deps;

  if (!agent) throw new Error("voice pwa: agent dep missing");
  if (!agentsYamlPath) throw new Error("voice pwa: agentsYamlPath missing");

  // Resolve staticDir once so path-traversal checks below compare absolutes.
  const staticRoot = staticDir ? resolve(staticDir) : null;

  /** Read agents.yaml fresh on each call. Cheap (<1ms) and picks up label
   *  edits via `amux label` without restarting the bot. */
  function loadAgents() {
    if (!existsSync(agentsYamlPath)) return {};
    try { return yaml.load(readFileSync(agentsYamlPath, "utf-8")) || {}; }
    catch { return {}; }
  }

  function listAgentsForResponse() {
    const doc = loadAgents();
    const agents = [];
    for (const [name, entry] of Object.entries(doc)) {
      if (!entry?.dir) continue;
      const panes = (entry.panes || []).map((p, idx) => ({
        index: idx,
        command: p.cmd?.split(" ")[0] || "unknown",
        label: p.label || null,
      }));
      agents.push({ name, dir: entry.dir, panes });
    }
    agents.sort((a, b) => a.name.localeCompare(b.name));
    return { agents };
  }

  function findChannelIdForPane(name, pane) {
    const doc = loadAgents();
    const disc = doc[name]?.discord;
    if (!disc) return null;
    if (typeof disc === "string") return pane === 0 ? disc : null;
    for (const [cid, idx] of Object.entries(disc)) {
      if (Number(idx) === Number(pane)) return String(cid);
    }
    return null;
  }

  function validatePane(name, pane) {
    const doc = loadAgents();
    const entry = doc[name];
    if (!entry) {
      const known = Object.keys(doc).sort();
      return { ok: false, error: `unknown agent '${name}'. Known: ${known.join(", ") || "(none)"}` };
    }
    const paneCount = (entry.panes || []).length;
    if (pane < 0 || pane >= paneCount) {
      return { ok: false, error: `pane ${pane} does not exist. '${name}' has ${paneCount} pane${paneCount === 1 ? "" : "s"} (0-${paneCount - 1}).` };
    }
    return { ok: true };
  }

  // ---------- HTTP plumbing ---------------------------------------------

  function json(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  function readBody(req, limit = 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on("data", (c) => {
        total += c.length;
        if (total > limit) { req.destroy(); reject(new Error("payload too large")); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  async function parseJsonBody(req, limit) {
    const buf = await readBody(req, limit);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString("utf-8")); }
    catch { throw new Error("invalid JSON body"); }
  }

  // ---------- Route handlers --------------------------------------------

  async function handleAgents(req, res) {
    json(res, 200, listAgentsForResponse());
  }

  async function handleSend(req, res, name, paneStr) {
    const pane = parseInt(paneStr);
    if (Number.isNaN(pane)) return json(res, 400, { error: "pane must be an integer" });
    const v = validatePane(name, pane);
    if (!v.ok) return json(res, 400, { error: v.error });

    let body;
    try { body = await parseJsonBody(req, MAX_AUDIO_BYTES + 1024 * 1024); }
    catch (err) { return json(res, 400, { error: err.message }); }

    let text = null;
    let transcript = null;
    if (typeof body.text === "string" && body.text.trim()) {
      text = body.text;
    } else if (typeof body.audio === "string" && body.audio.length > 0) {
      // base64 audio blob → tmp file → whisper transcript
      const ext = (body.filename?.split(".").pop() || "webm").toLowerCase().replace(/[^a-z0-9]/g, "") || "webm";
      const tmpPath = join("/tmp", `voice-pwa-${randomBytes(8).toString("hex")}.${ext}`);
      try {
        writeFileSync(tmpPath, Buffer.from(body.audio, "base64"));
      } catch (err) {
        return json(res, 400, { error: `invalid base64 audio: ${err.message}` });
      }
      try {
        const lang = (body.lang || "sv").replace(/[^a-z]/g, "");
        const { stdout } = await run(`'${esc(transcribeScript)}' '${esc(tmpPath)}' '${esc(lang)}'`, 60000);
        const raw = String(stdout || "").trim();
        if (!raw) {
          return json(res, 422, { error: "transcription empty — audio may have been silent or unintelligible" });
        }
        transcript = raw;
        text = `${TRANSCRIPT_PREFIX} ${raw}`;
      } catch (err) {
        return json(res, 500, { error: `transcription failed: ${err.message}` });
      } finally {
        try { unlinkSync(tmpPath); } catch {}
      }
    } else {
      return json(res, 400, { error: "body must contain either 'text' or 'audio' (base64)" });
    }

    // Send to tmux pane
    try { await agent.sendOnly(name, text, pane); }
    catch (err) { return json(res, 500, { error: `send failed: ${err.message}` }); }

    // Best-effort mirror to Discord for channel parity (see 57b927b, b6c3107).
    // Failure here is a transparency degradation, not a correctness issue:
    // the pane already received the input.
    if (mirror?.send) {
      const channelId = findChannelIdForPane(name, pane);
      if (channelId) {
        try { await mirror.send(channelId, `[voice-pwa] ${text}`); }
        catch (err) { console.warn(`voice-pwa mirror ${name}:${pane}: ${err.message}`); }
      }
    }

    json(res, 200, { sent: text, transcript });
  }

  /**
   * Last-line-of-defence pane-chrome stripper. Mirrors the frontend
   * cleanForTts so even a stale-cached PWA can't make edge-tts read
   * "Opus 4.7 (1M context) │ 0 █░░░ 14%" out loud.
   */
  function stripPaneChrome(input) {
    const lines = String(input).split("\n");
    const kept = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { kept.push(""); continue; }
      if (/^[│|]?\s*(opus|sonnet|haiku|gpt-?\d|claude|codex)[\s\d.()xMK,a-zA-Z-]*(\(.*context\).*|│.*\d+%?\s*$)?$/i.test(line)) continue;
      if (/(opus|sonnet|haiku|gpt-?\d|claude|codex).*\(.*context\).*/i.test(line)) continue;
      if (/^[█▓▒░\s│|·▏▎▍▌▋▊▉]+(\d+\s*%)?$/.test(line)) continue;
      if (/[█▓▒░]{2,}/.test(line) && line.length < 80) continue;
      if (/^[✻✢⏵⎿⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(line)) continue;
      if (/(esc to interrupt|tokens?\s*[\)·]|still thinking|thought for)/i.test(line)) continue;
      if (/bypass permissions on/i.test(line)) continue;
      if (/shift\+tab to cycle/i.test(line)) continue;
      if (/^[❯>$]\s*$/.test(line)) continue;
      if (/^[─━═-]+$/.test(line)) continue;
      kept.push(raw);
    }
    return kept.join("\n").trim();
  }

  async function handleTts(req, res) {
    let body;
    try { body = await parseJsonBody(req); }
    catch (err) { return json(res, 400, { error: err.message }); }
    const rawText = String(body.text || "").trim();
    if (!rawText) return json(res, 400, { error: "'text' required" });

    const stripped = stripPaneChrome(rawText);
    if (!stripped) return json(res, 400, { error: "nothing to speak after stripping pane chrome" });
    const clean = stripped.replace(/[`*_~|]/g, "").slice(0, 4000);
    const voice = body.voice || ttsVoice;
    // edge-tts --rate takes a percentage offset from the native pace.
    // speed=1.0 → +0%, speed=1.5 → +50%, speed=0.75 → -25%. Clamp to a
    // sensible range so a bad input can't break the synth call.
    const speedRaw = typeof body.speed === "number" ? body.speed : 1.0;
    const speed = Math.max(0.5, Math.min(2.5, speedRaw));
    const offset = Math.round((speed - 1) * 100);
    const rateFlag = `${offset >= 0 ? "+" : ""}${offset}%`;
    const tmpPath = join("/tmp", `voice-pwa-tts-${randomBytes(8).toString("hex")}.mp3`);
    try {
      await run(`edge-tts --voice '${esc(voice)}' --rate='${esc(rateFlag)}' --text '${esc(clean)}' --write-media '${esc(tmpPath)}'`, 30000);
    } catch (err) {
      return json(res, 500, { error: `tts failed: ${err.message}` });
    }
    try {
      const audio = readFileSync(tmpPath);
      res.writeHead(200, {
        "content-type": "audio/mpeg",
        "content-length": audio.length,
        "cache-control": "no-store",
      });
      res.end(audio);
    } finally {
      try { unlinkSync(tmpPath); } catch {}
    }
  }

  /**
   * SSE stream of pane status + text response. Polls pane on POLL_INTERVAL_MS.
   * Emits a status event whenever status transitions, and when going
   * working→idle pulls the final turn (via agent.getResponse which already
   * reads jsonl when available) and emits text + done. The client can
   * reopen the stream for the next turn.
   */
  async function handleEvents(req, res, name, paneStr) {
    const pane = parseInt(paneStr);
    if (Number.isNaN(pane)) return json(res, 400, { error: "pane must be an integer" });
    const v = validatePane(name, pane);
    if (!v.ok) return json(res, 400, { error: v.error });

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    });
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write("open", { agent: name, pane });

    let lastStatus = null;
    let sawWorking = false;
    let closed = false;
    let doneEmitted = false;

    req.on("close", () => { closed = true; });

    while (!closed) {
      let status = "unknown";
      try { status = await agent.isBusy(name, pane) ? "working" : "idle"; }
      catch { status = "unknown"; }

      if (status !== lastStatus) {
        write("status", { state: status });
        lastStatus = status;
      }
      if (status === "working") sawWorking = true;

      if (status === "idle" && sawWorking && !doneEmitted) {
        try {
          const text = await agent.getResponse(name, pane);
          if (text && text !== "(empty response)") write("text", { content: text });
        } catch (err) {
          write("error", { message: `response extract failed: ${err.message}` });
        }
        write("done", {});
        doneEmitted = true;
        // Stay connected for one more poll cycle so client observes the
        // done event before reconnecting. Browsers sometimes retry if we
        // close too fast.
        await new Promise((r) => setTimeout(r, 200));
        break;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }

    if (!res.writableEnded) res.end();
  }

  // ---------- Request dispatcher ----------------------------------------

  // Resolve a request path against staticRoot, refusing anything that escapes
  // the root (defense in depth — req.url paths are normalized but a hostile
  // backend or proxy could still feed us "../" sequences).
  function resolveStaticPath(reqPath) {
    if (!staticRoot) return null;
    const decoded = decodeURIComponent(reqPath);
    const cleaned = decoded === "/" ? "/index.html" : decoded;
    const abs = resolve(staticRoot, "." + cleaned);
    if (abs !== staticRoot && !abs.startsWith(staticRoot + "/")) return null;
    if (!existsSync(abs)) return null;
    try {
      if (!statSync(abs).isFile()) return null;
    } catch { return null; }
    return abs;
  }

  function serveStatic(req, res, path) {
    const filePath = resolveStaticPath(path);
    // SPA fallback: any unknown non-/api path → index.html (client router takes over)
    const target = filePath || (staticRoot && !path.startsWith("/api/")
      ? resolveStaticPath("/index.html")
      : null);
    if (!target) return false;

    try {
      const buf = readFileSync(target);
      const mime = MIME[extname(target).toLowerCase()] || "application/octet-stream";
      const isShell = target.endsWith("/index.html");
      res.writeHead(200, {
        "content-type": mime,
        "content-length": buf.length,
        // Hashed asset paths (_app/...) get long cache; the SPA shell stays no-cache
        // so users see new builds immediately.
        "cache-control": isShell ? "no-cache" : "public, max-age=31536000, immutable",
      });
      res.end(buf);
      return true;
    } catch (err) {
      console.warn(`voice-pwa static ${path}: ${err.message}`);
      return false;
    }
  }

  async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "x"}`);
    const path = url.pathname;

    // CORS for PWA served from different origin (legacy — same-origin deploy
    // doesn't need this, but keep it permissive so external clients still work).
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // Static PWA bundle: any non-/api GET serves a file (or index.html via
    // SPA fallback). API routes follow below.
    if (staticRoot && req.method === "GET" && !path.startsWith("/api/")) {
      if (serveStatic(req, res, path)) return;
    }

    try {
      if (req.method === "GET" && path === "/api/agents") {
        return await handleAgents(req, res);
      }
      if (req.method === "POST" && path === "/api/tts") {
        return await handleTts(req, res);
      }
      const mSend = path.match(/^\/api\/send\/([^/]+)\/(\d+)$/);
      if (mSend && req.method === "POST") {
        return await handleSend(req, res, decodeURIComponent(mSend[1]), mSend[2]);
      }
      const mEvents = path.match(/^\/api\/events\/([^/]+)\/(\d+)$/);
      if (mEvents && req.method === "GET") {
        return await handleEvents(req, res, decodeURIComponent(mEvents[1]), mEvents[2]);
      }
      return json(res, 404, { error: `no route for ${req.method} ${path}` });
    } catch (err) {
      console.error(`voice-pwa ${req.method} ${path}: ${err.stack || err.message}`);
      if (!res.headersSent) json(res, 500, { error: "internal error" });
    }
  }

  let server = null;

  return {
    _handler: handler,
    listAgents: listAgentsForResponse,
    validatePane,

    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(handler);
        server.on("error", reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolve({ url: `http://${addr.address}:${addr.port}` });
        });
      });
    },

    async stop() {
      if (!server) return;
      await new Promise((r) => server.close(r));
      server = null;
    },
  };
}
