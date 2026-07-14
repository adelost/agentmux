#!/usr/bin/env node
/**
 * amux web-ui spike — drive Claude sessions over a machine API and render the
 * stream in a browser. Zero tmux, zero screen scraping.
 *
 * Answers (memory/references/amux-transport-freeze-browser-interface.md):
 *   1. Can a message go IN via a clean API?            → POST /api/conversations[/:id/messages]
 *   2. Is the session WATCHABLE live in a browser?     → SSE replay + live stream
 *   3. Does conversational continuity survive?         → --resume <latest session id>
 *
 * The stream-json events ARE the delivery truth: no paste, no composer state,
 * no wrap/pager/torn-frame bug class (claw:2's list) can exist on this path.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.SPIKE_PORT || 8811);
const DEFAULT_MODEL = process.env.SPIKE_MODEL || "claude-haiku-4-5-20251001";
const ROOT = dirname(fileURLToPath(import.meta.url));

/** conversationId → { id, model, cwd, sessionId, running, events, clients, seenKeys } */
const conversations = new Map();
/** idempotencyKey → conversationId, for POST /api/conversations replays. */
const creationKeys = new Map();

/** A nested `claude` must not inherit harness vars (breaks jsonl writing). */
const cleanChildEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_)/i.test(key)) delete env[key];
  }
  return env;
};

const broadcast = (conv, event) => {
  conv.events.push(event);
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of conv.clients) client.write(frame);
};

const spikeEvent = (conv, subtype, extra = {}) =>
  broadcast(conv, { type: "spike", subtype, at: Date.now(), ...extra });

/** One prompt → one `claude -p` run; --resume chains runs into a conversation. */
const runTurn = (conv, prompt) => {
  conv.running = true;
  spikeEvent(conv, "user", { text: prompt });
  const args = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", conv.model,
  ];
  if (conv.sessionId) args.push("--resume", conv.sessionId);

  const child = spawn("claude", args, {
    cwd: conv.cwd,
    env: cleanChildEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch {
      // Fail loud: a non-JSON line on this path is itself a finding.
      spikeEvent(conv, "protocol-error", { line });
      return;
    }
    if (event.session_id) conv.sessionId = event.session_id;
    broadcast(conv, event);
  });

  child.on("close", (code) => {
    conv.running = false;
    spikeEvent(conv, "turn-done", { code, stderr: code === 0 ? undefined : stderr });
  });
};

const readJsonBody = (request) => new Promise((resolve) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    try { resolve(JSON.parse(body)); } catch { resolve(null); }
  });
});

const json = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

const conversationSummary = (conv) => ({
  id: conv.id,
  model: conv.model,
  sessionId: conv.sessionId,
  running: conv.running,
  events: conv.events.length,
});

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const { pathname } = url;

  if (request.method === "GET" && pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(readFileSync(join(ROOT, "index.html")));
    return;
  }

  if (request.method === "GET" && pathname === "/api/conversations") {
    json(response, 200, { conversations: [...conversations.values()].map(conversationSummary) });
    return;
  }

  if (request.method === "POST" && pathname === "/api/conversations") {
    const body = await readJsonBody(request);
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) {
      json(response, 400, { error: "prompt-required" });
      return;
    }
    if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim()) {
      json(response, 400, { error: "idempotency-key-required" });
      return;
    }
    // Retry of an already-landed create must NOT start a second turn.
    const existingId = creationKeys.get(body.idempotencyKey);
    if (existingId) {
      json(response, 200, { ...conversationSummary(conversations.get(existingId)), replayed: true });
      return;
    }
    const conv = {
      id: randomUUID(),
      model: typeof body.model === "string" ? body.model : DEFAULT_MODEL,
      cwd: typeof body.cwd === "string" ? body.cwd : ROOT,
      sessionId: null,
      running: false,
      events: [],
      clients: new Set(),
      seenKeys: new Set(),
    };
    conversations.set(conv.id, conv);
    creationKeys.set(body.idempotencyKey, conv.id);
    runTurn(conv, body.prompt.trim());
    json(response, 201, conversationSummary(conv));
    return;
  }

  const messageMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})\/messages$/);
  if (request.method === "POST" && messageMatch) {
    const conv = conversations.get(messageMatch[1]);
    if (!conv) { json(response, 404, { error: "conversation-not-found" }); return; }
    const body = await readJsonBody(request);
    if (typeof body?.prompt !== "string" || !body.prompt.trim()) {
      json(response, 400, { error: "prompt-required" });
      return;
    }
    if (typeof body.idempotencyKey !== "string" || !body.idempotencyKey.trim()) {
      json(response, 400, { error: "idempotency-key-required" });
      return;
    }
    // Retry of an already-landed message must NOT re-run the turn.
    if (conv.seenKeys.has(body.idempotencyKey)) {
      json(response, 200, { ...conversationSummary(conv), replayed: true });
      return;
    }
    if (conv.running) { json(response, 409, { error: "turn-in-progress" }); return; }
    conv.seenKeys.add(body.idempotencyKey);
    runTurn(conv, body.prompt.trim());
    json(response, 202, conversationSummary(conv));
    return;
  }

  const eventsMatch = pathname.match(/^\/api\/conversations\/([0-9a-f-]{36})\/events$/);
  if (request.method === "GET" && eventsMatch) {
    const conv = conversations.get(eventsMatch[1]);
    if (!conv) { json(response, 404, { error: "conversation-not-found" }); return; }
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    // Replay = watchability: a late-joining browser sees the full history.
    for (const event of conv.events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    conv.clients.add(response);
    request.on("close", () => conv.clients.delete(response));
    return;
  }

  json(response, 404, { error: "route-not-found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`amux web-ui spike: http://127.0.0.1:${PORT} (model ${DEFAULT_MODEL})`);
});
