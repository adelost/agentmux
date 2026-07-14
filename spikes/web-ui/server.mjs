#!/usr/bin/env node
/**
 * Browser-native agent sessions for agentmux.
 *
 * A project owns a trusted working directory. Agents created inside the
 * project inherit that directory and only persist a small registry record:
 * engine, model and the engine's native session id. Each message launches one
 * headless CLI turn and resumes that native session. There is no tmux input,
 * terminal scraping or second conversation database on this path.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { claudeProjectDir } from "../../core/claude-paths.mjs";
import { readTailWindow } from "../../core/jsonl-reader.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const JSON_MAX_BYTES = 256 * 1024;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const HISTORY_MAX_BYTES = 32 * 1024 * 1024;
const MEMORY_EVENT_LIMIT = 5_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

const DEFAULT_MODELS = Object.freeze({
  claude: ["claude-opus-4-8", "fable", "sonnet", "haiku"],
  codex: ["gpt-5.6-sol"],
});

const UPLOAD_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp",
  ".txt", ".md", ".log", ".json", ".jsonl", ".csv", ".pdf", ".zip",
  ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html",
  ".xml", ".yaml", ".yml", ".toml", ".sh", ".py", ".java", ".kt",
  ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".sql",
]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const defaultCommunicationPolicy = () => ({
  version: 1,
  read: "all_agents",
  send: { mode: "open", allow: {} },
  enforced: false,
});

const now = () => Date.now();
const hashPayload = (payload) => createHash("sha256")
  .update(JSON.stringify(payload))
  .digest("hex");

const cleanName = (value, max = 64) => typeof value === "string"
  ? value.trim().replace(/\s+/g, " ").slice(0, max)
  : "";

const expandDirectory = (value, homeDir) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  if (raw === "~") return homeDir;
  if (raw.startsWith(`~${sep}`)) return resolve(homeDir, raw.slice(2));
  return resolve(raw);
};

const textOf = (content) => typeof content === "string"
  ? content
  : (Array.isArray(content) ? content : [])
    .filter((block) => typeof block?.text === "string"
      && ["text", "input_text", "output_text"].includes(block.type))
    .map((block) => block.text)
    .join("");

const isEngineNoise = (text) => {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<environment_context")
    || trimmed.startsWith("<user_instructions")
    || trimmed.startsWith("# AGENTS.md instructions");
};

const publicHeaders = (extra = {}) => ({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  ...extra,
});

const readRawBody = (request, maxBytes) => new Promise((resolveBody, rejectBody) => {
  const declared = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    rejectBody(Object.assign(new Error("body-too-large"), { status: 413 }));
    return;
  }

  const chunks = [];
  let size = 0;
  let tooLarge = false;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBytes) {
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    if (!tooLarge) chunks.push(chunk);
  });
  request.on("end", () => {
    if (tooLarge) {
      rejectBody(Object.assign(new Error("body-too-large"), { status: 413 }));
      return;
    }
    resolveBody(Buffer.concat(chunks));
  });
  request.on("error", rejectBody);
});

const readJsonBody = async (request) => {
  const raw = await readRawBody(request, JSON_MAX_BYTES);
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid-json"), { status: 400 });
  }
};

const cleanChildEnv = () => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_)/i.test(key)) delete env[key];
  }
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_CI;
  return env;
};

/**
 * @param {object} [options]
 * @param {string} [options.dataDir]
 * @param {string|null} [options.legacyDataDir]
 * @param {string} [options.homeDir]
 * @param {Function} [options.spawnProcess]
 * @param {string} [options.claudeCommand]
 * @param {string} [options.codexCommand]
 */
export function createWebUi(options = {}) {
  const bootId = randomUUID();
  const homeDir = options.homeDir ?? homedir();
  const dataDir = resolve(options.dataDir
    ?? process.env.AMUX_WEB_DATA_DIR
    ?? join(homeDir, ".agentmux", "web-ui"));
  const legacyDataDir = options.legacyDataDir === undefined
    ? join(ROOT, "data")
    : options.legacyDataDir;
  const registryPath = join(dataDir, "registry.json");
  const uploadDir = join(dataDir, "uploads");
  const spawnProcess = options.spawnProcess ?? spawn;
  const commands = {
    claude: options.claudeCommand ?? process.env.AMUX_WEB_CLAUDE_COMMAND ?? "claude",
    codex: options.codexCommand ?? process.env.AMUX_WEB_CODEX_COMMAND ?? "codex",
  };
  const models = {
    claude: [...(options.models?.claude ?? DEFAULT_MODELS.claude)],
    codex: [...(options.models?.codex ?? DEFAULT_MODELS.codex)],
  };

  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir, 0o700); } catch {}
  try { chmodSync(uploadDir, 0o700); } catch {}

  /** @type {Map<string, object>} */
  const projects = new Map();
  /** @type {Map<string, object>} */
  const agents = new Map();
  const receipts = {
    projectCreates: new Map(),
    agentCreates: new Map(),
    messages: new Map(),
    sideQuestions: new Map(),
  };
  const sideRuns = new Map();
  const sideChildren = new Set();

  const rememberReceipt = (map, key, value, limit = Number.POSITIVE_INFINITY) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  };

  const publicAgent = (agent) => {
    const project = projects.get(agent.projectId);
    return {
      id: agent.id,
      projectId: agent.projectId,
      name: agent.name,
      engine: agent.engine,
      model: agent.model,
      cwd: project?.cwd ?? null,
      sessionId: agent.sessionId,
      running: agent.running,
      createdAt: agent.createdAt,
      updatedAt: agent.updatedAt,
    };
  };

  const publicProject = (project) => ({
    id: project.id,
    name: project.name,
    cwd: project.cwd,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    communicationPolicy: project.communicationPolicy,
    agents: [...agents.values()]
      .filter((agent) => agent.projectId === project.id)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(publicAgent),
  });

  const saveRegistry = () => {
    const body = JSON.stringify({
      schemaVersion: 1,
      projects: [...projects.values()].map((project) => ({
        id: project.id,
        name: project.name,
        cwd: project.cwd,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        communicationPolicy: project.communicationPolicy,
      })),
      agents: [...agents.values()].map((agent) => ({
        id: agent.id,
        projectId: agent.projectId,
        name: agent.name,
        engine: agent.engine,
        model: agent.model,
        sessionId: agent.sessionId,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      })),
      receipts: Object.fromEntries(Object.entries(receipts)
        .map(([name, map]) => [name, Object.fromEntries(map)])),
    }, null, 2);
    const temporary = `${registryPath}.${process.pid}.tmp`;
    writeFileSync(temporary, body, { mode: 0o600 });
    renameSync(temporary, registryPath);
    try { chmodSync(registryPath, 0o600); } catch {}
  };

  const restoreAgent = (entry) => ({
    id: entry.id,
    projectId: entry.projectId,
    name: entry.name,
    engine: entry.engine,
    model: entry.model,
    sessionId: entry.sessionId ?? null,
    createdAt: entry.createdAt ?? now(),
    updatedAt: entry.updatedAt ?? entry.createdAt ?? now(),
    running: false,
    activeChild: null,
    events: [],
    clients: new Set(),
    hydrated: false,
    nextEventId: 1,
    turnHasAssistantText: false,
  });

  const loadRegistry = () => {
    if (!existsSync(registryPath)) return false;
    const stored = JSON.parse(readFileSync(registryPath, "utf8"));
    if (stored.schemaVersion !== 1) throw new Error(`unsupported registry schema ${stored.schemaVersion}`);
    for (const entry of stored.projects ?? []) {
      projects.set(entry.id, {
        ...entry,
        communicationPolicy: entry.communicationPolicy ?? defaultCommunicationPolicy(),
      });
    }
    for (const entry of stored.agents ?? []) {
      if (!projects.has(entry.projectId)) throw new Error(`agent ${entry.id} has missing project`);
      if (!commands[entry.engine]) throw new Error(`agent ${entry.id} has unknown engine`);
      agents.set(entry.id, restoreAgent(entry));
    }
    for (const [name, map] of Object.entries(receipts)) {
      for (const [key, value] of Object.entries(stored.receipts?.[name] ?? {})) map.set(key, value);
    }
    return true;
  };

  const migrateLegacyEvents = () => {
    if (!legacyDataDir || !existsSync(legacyDataDir)) return false;
    const files = readdirSync(legacyDataDir)
      .filter((file) => file.endsWith(".events.jsonl"))
      .sort();
    if (!files.length) return false;

    const recovered = [];
    for (const file of files) {
      const path = join(legacyDataDir, file);
      const lines = readTailWindow(path, 2 * 1024 * 1024).text.split("\n");
      let init = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === "system" && event.subtype === "init" && event.session_id) {
            init = event;
            break;
          }
        } catch {}
      }
      if (!init) continue;
      recovered.push({
        id: basename(file, ".events.jsonl"),
        sessionId: init.session_id,
        model: init.model || models.claude[0],
        cwd: init.cwd || ROOT,
        mtime: statSync(path).mtimeMs,
      });
    }
    if (!recovered.length) return false;

    const project = {
      id: randomUUID(),
      name: "Tidigare web-spike",
      cwd: recovered[0].cwd,
      createdAt: Math.min(...recovered.map((entry) => entry.mtime)),
      updatedAt: now(),
      communicationPolicy: defaultCommunicationPolicy(),
    };
    projects.set(project.id, project);
    recovered.forEach((entry, index) => {
      const id = new RegExp(`^${UUID_PATTERN}$`, "i").test(entry.id) ? entry.id : randomUUID();
      agents.set(id, restoreAgent({
        id,
        projectId: project.id,
        name: `Tidigare Claude ${index + 1}`,
        engine: "claude",
        model: entry.model,
        sessionId: entry.sessionId,
        createdAt: entry.mtime,
        updatedAt: entry.mtime,
      }));
    });
    saveRegistry();
    return true;
  };

  if (!loadRegistry()) migrateLegacyEvents();

  const sessionFileFor = (agent) => {
    if (!agent.sessionId) return null;
    const project = projects.get(agent.projectId);
    if (!project) return null;
    if (agent.engine === "claude") {
      return join(claudeProjectDir(project.cwd, homeDir), `${agent.sessionId}.jsonl`);
    }
    const base = join(homeDir, ".codex", "sessions");
    if (!existsSync(base)) return null;
    try {
      const match = readdirSync(base, { recursive: true })
        .find((file) => String(file).endsWith(".jsonl") && String(file).includes(agent.sessionId));
      return match ? join(base, String(match)) : null;
    } catch {
      return null;
    }
  };

  const pushEvent = (agent, event) => {
    if (!event.webId) event.webId = `${bootId}:${agent.nextEventId++}`;
    agent.events.push(event);
    if (agent.events.length > MEMORY_EVENT_LIMIT) {
      agent.events.splice(0, agent.events.length - MEMORY_EVENT_LIMIT);
    }
  };

  const hydrate = (agent) => {
    if (agent.hydrated || !agent.sessionId || agent.events.length) return;
    agent.hydrated = true;
    const path = sessionFileFor(agent);
    if (!path || !existsSync(path)) {
      pushEvent(agent, { type: "web", subtype: "history-unavailable", at: now() });
      return;
    }

    const lines = readTailWindow(path, HISTORY_MAX_BYTES).text.split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (agent.engine === "claude") {
        if (entry.type === "user" && !entry.isMeta) {
          const text = textOf(entry.message?.content);
          if (text && !text.startsWith("[Request interrupted") && !isEngineNoise(text)) {
            pushEvent(agent, { type: "web", subtype: "user", text, at: entry.timestamp ?? 0 });
          }
        } else if (entry.type === "assistant") {
          const text = textOf(entry.message?.content);
          if (text) pushEvent(agent, {
            type: "assistant",
            message: { content: [{ type: "text", text }] },
            at: entry.timestamp ?? 0,
          });
        }
      } else if (entry.type === "response_item" && entry.payload?.type === "message") {
        const text = textOf(entry.payload.content);
        if (!text || isEngineNoise(text)) continue;
        if (entry.payload.role === "user") {
          pushEvent(agent, { type: "web", subtype: "user", text, at: entry.timestamp ?? 0 });
        } else if (entry.payload.role === "assistant") {
          pushEvent(agent, {
            type: "assistant",
            message: { content: [{ type: "text", text }] },
            at: entry.timestamp ?? 0,
          });
        }
      }
    }
  };

  const broadcast = (agent, event) => {
    pushEvent(agent, event);
    const frame = `id: ${event.webId}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const response of agent.clients) response.write(frame);
  };

  const webEvent = (agent, subtype, extra = {}) => broadcast(agent, {
    type: "web",
    subtype,
    at: now(),
    ...extra,
  });

  const publicAttachment = (projectId, attachment) => ({
    name: attachment.name,
    bytes: attachment.bytes,
    image: attachment.image,
    url: `/api/uploads/${projectId}/${encodeURIComponent(basename(attachment.path))}`,
  });

  const attachmentPrompt = (prompt, attachments) => attachments.reduce((text, attachment) => {
    const label = attachment.image ? "Bifogad bild" : "Bifogad fil";
    return `${text}\n[${label}: ${attachment.path}]`;
  }, prompt);

  const buildLaunch = (agent, rawPrompt, attachments) => {
    const project = projects.get(agent.projectId);
    if (agent.engine === "claude") {
      const prompt = attachmentPrompt(rawPrompt, attachments);
      const args = [
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--model", agent.model,
        "--permission-mode", "acceptEdits",
        "--name", agent.name,
      ];
      if (agent.sessionId) args.push("--resume", agent.sessionId);
      return { command: commands.claude, args, prompt };
    }

    const images = attachments.filter((attachment) => attachment.image);
    const otherFiles = attachments.filter((attachment) => !attachment.image);
    const prompt = attachmentPrompt(rawPrompt, otherFiles);
    const common = ["--json", "--skip-git-repo-check", "-m", agent.model];
    for (const image of images) common.push("-i", image.path);
    const args = agent.sessionId
      ? ["exec", "resume", ...common, agent.sessionId, prompt]
      : ["exec", ...common, "-C", project.cwd, prompt];
    return { command: commands.codex, args, prompt };
  };

  const recordSessionId = (agent, sessionId) => {
    if (!sessionId || sessionId === agent.sessionId) return;
    agent.sessionId = sessionId;
    agent.updatedAt = now();
    saveRegistry();
  };

  const mapEngineEvent = (agent, event) => {
    if (agent.engine === "claude") {
      recordSessionId(agent, event.session_id);
      if (event.type === "stream_event"
          && event.event?.type === "content_block_delta"
          && event.event.delta?.type === "text_delta") {
        broadcast(agent, event);
      } else if (event.type === "assistant") {
        const text = textOf(event.message?.content);
        if (text) {
          agent.turnHasAssistantText = true;
          broadcast(agent, event);
        }
      } else if (event.type === "result") {
        if (!agent.turnHasAssistantText && typeof event.result === "string" && event.result.trim()) {
          agent.turnHasAssistantText = true;
          broadcast(agent, {
            type: "assistant",
            message: { content: [{ type: "text", text: event.result }] },
          });
        }
        broadcast(agent, event);
      }
      return;
    }
    recordSessionId(agent, event.thread_id);
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      agent.turnHasAssistantText = true;
      broadcast(agent, {
        type: "assistant",
        message: { content: [{ type: "text", text: event.item.text ?? "" }] },
      });
    } else if (event.type === "turn.completed") {
      broadcast(agent, {
        type: "result",
        subtype: "success",
        engine: "codex",
        usage: event.usage ?? null,
        session_id: agent.sessionId,
      });
    }
  };

  const runTurn = (agent, rawPrompt, attachments) => {
    const project = projects.get(agent.projectId);
    hydrate(agent);
    const launch = buildLaunch(agent, rawPrompt, attachments);
    agent.running = true;
    agent.turnHasAssistantText = false;
    agent.updatedAt = now();
    webEvent(agent, "user", {
      text: rawPrompt,
      attachments: attachments.map((attachment) => publicAttachment(project.id, attachment)),
    });

    let child;
    let stderr = "";
    let finished = false;
    const finish = (code, error = null) => {
      if (finished) return;
      finished = true;
      agent.running = false;
      agent.activeChild = null;
      agent.updatedAt = now();
      agent.events = agent.events.filter((event) => event.type !== "stream_event");
      saveRegistry();
      webEvent(agent, "turn-done", {
        code,
        error: error?.message,
        stderr: code === 0 ? undefined : stderr.slice(-32_000),
      });
    };

    try {
      child = spawnProcess(launch.command, launch.args, {
        cwd: project.cwd,
        env: cleanChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      agent.activeChild = child;
    } catch (error) {
      finish(-1, error);
      return;
    }

    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-32_000);
    });
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch {
          webEvent(agent, "protocol-error", { line: line.slice(0, 4_000) });
          return;
        }
        mapEngineEvent(agent, event);
      });
    }
    child.once?.("error", (error) => finish(-1, error));
    child.once?.("close", (code) => finish(Number.isInteger(code) ? code : -1));
  };

  const runSideQuestion = (agent, question) => new Promise((resolveAnswer, rejectAnswer) => {
    const sidePrompt = [
      "[SIDOFRÅGA — ändra eller fortsätt inte huvuduppgiften]",
      "Svara kort utifrån den befintliga konversationens kontext. Detta är en fristående fråga.",
      "",
      question,
    ].join("\n");
    const args = [
      "-p", sidePrompt,
      "--output-format", "stream-json",
      "--verbose",
      "--model", agent.model,
      "--permission-mode", "plan",
      "--resume", agent.sessionId,
      "--fork-session",
      "--no-session-persistence",
    ];
    let child;
    let stderr = "";
    let answer = "";
    let finished = false;
    const timeout = setTimeout(() => {
      try { child?.kill?.("SIGTERM"); } catch {}
      finish(new Error("side-question-timeout"));
    }, 120_000);
    timeout.unref?.();

    const finish = (error = null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (child) sideChildren.delete(child);
      if (error) { rejectAnswer(error); return; }
      if (!answer.trim()) {
        rejectAnswer(new Error(stderr.trim() || "side-question-empty-result"));
        return;
      }
      resolveAnswer(answer.trim());
    };

    try {
      const project = projects.get(agent.projectId);
      child = spawnProcess(commands.claude, args, {
        cwd: project.cwd,
        env: cleanChildEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      sideChildren.add(child);
    } catch (error) {
      finish(error);
      return;
    }

    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); });
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          if (event.type === "result" && typeof event.result === "string") answer = event.result;
          if (event.type === "assistant") {
            const text = textOf(event.message?.content);
            if (text) answer = text;
          }
        } catch {}
      });
    }
    child.once?.("error", (error) => finish(error));
    child.once?.("close", (code) => finish(code === 0 ? null : new Error(stderr.trim() || `side-question-exit-${code}`)));
  });

  const json = (response, status, body) => {
    response.writeHead(status, publicHeaders({ "content-type": "application/json; charset=utf-8" }));
    response.end(JSON.stringify(body));
  };

  const receiptResult = (map, key, payloadHash) => {
    const receipt = map.get(key);
    if (!receipt) return null;
    if (receipt.hash !== payloadHash) return { conflict: true };
    return { replayed: true, id: receipt.id };
  };

  const attachmentFor = (projectId, value) => {
    if (!value || typeof value.path !== "string") return null;
    const base = resolve(uploadDir, projectId);
    const path = resolve(value.path);
    if (path !== base && !path.startsWith(`${base}${sep}`)) return null;
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const extension = extname(path).toLowerCase();
    return {
      path,
      name: cleanName(value.name, 180) || basename(path),
      bytes: statSync(path).size,
      image: IMAGE_EXTENSIONS.has(extension),
    };
  };

  const serveStatic = (response, file, contentType) => {
    response.writeHead(200, publicHeaders({
      "content-type": contentType,
      "content-security-policy": "default-src 'self'; connect-src 'self'; img-src 'self' blob: data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    }));
    response.end(readFileSync(join(ROOT, file)));
  };

  const handler = async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const { pathname } = url;

    if (request.method === "GET" && pathname === "/") {
      serveStatic(response, "index.html", "text/html; charset=utf-8");
      return;
    }
    if (request.method === "GET" && pathname === "/app.js") {
      serveStatic(response, "app.js", "application/javascript; charset=utf-8");
      return;
    }
    if (request.method === "GET" && pathname === "/style.css") {
      serveStatic(response, "style.css", "text/css; charset=utf-8");
      return;
    }
    if (request.method === "GET" && pathname === "/favicon.ico") {
      response.writeHead(204, publicHeaders());
      response.end();
      return;
    }

    if (request.method === "GET" && pathname === "/api/config") {
      json(response, 200, {
        models,
        limits: { uploadMaxBytes: UPLOAD_MAX_BYTES, uploadExtensions: [...UPLOAD_EXTENSIONS] },
        communicationPolicy: defaultCommunicationPolicy(),
        authBoundary: "loopback-tailnet",
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/projects") {
      json(response, 200, {
        projects: [...projects.values()]
          .sort((a, b) => a.createdAt - b.createdAt)
          .map(publicProject),
      });
      return;
    }

    if (request.method === "POST" && pathname === "/api/projects") {
      const body = await readJsonBody(request);
      const key = cleanName(body?.idempotencyKey, 160);
      const name = cleanName(body?.name);
      const cwd = expandDirectory(body?.cwd, homeDir);
      if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
      if (!name) { json(response, 400, { error: "project-name-required" }); return; }
      if (!cwd || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
        json(response, 400, { error: "cwd-not-a-directory", cwd }); return;
      }
      const fingerprint = hashPayload({ name, cwd });
      const receipt = receiptResult(receipts.projectCreates, key, fingerprint);
      if (receipt?.conflict) { json(response, 409, { error: "idempotency-key-conflict" }); return; }
      if (receipt?.replayed) {
        const project = projects.get(receipt.id);
        json(response, project ? 200 : 410, project
          ? { ...publicProject(project), replayed: true }
          : { error: "idempotency-target-deleted" });
        return;
      }
      const project = {
        id: randomUUID(),
        name,
        cwd,
        createdAt: now(),
        updatedAt: now(),
        communicationPolicy: defaultCommunicationPolicy(),
      };
      projects.set(project.id, project);
      rememberReceipt(receipts.projectCreates, key, { id: project.id, hash: fingerprint });
      saveRegistry();
      json(response, 201, publicProject(project));
      return;
    }

    const projectMatch = pathname.match(new RegExp(`^/api/projects/(${UUID_PATTERN})(/agents|/uploads)?$`, "i"));
    if (projectMatch) {
      const project = projects.get(projectMatch[1]);
      if (!project) { json(response, 404, { error: "project-not-found" }); return; }

      if (request.method === "DELETE" && !projectMatch[2]) {
        const projectAgents = [...agents.values()].filter((agent) => agent.projectId === project.id);
        if (projectAgents.some((agent) => agent.running)) {
          json(response, 409, { error: "project-has-running-agent" }); return;
        }
        for (const agent of projectAgents) {
          for (const client of agent.clients) client.end();
          agents.delete(agent.id);
        }
        projects.delete(project.id);
        saveRegistry();
        json(response, 200, { deleted: true, sessionsPreserved: true });
        return;
      }

      if (request.method === "POST" && projectMatch[2] === "/agents") {
        const body = await readJsonBody(request);
        const key = cleanName(body?.idempotencyKey, 160);
        const name = cleanName(body?.name);
        const engine = body?.engine === "codex" ? "codex" : body?.engine === "claude" ? "claude" : "";
        const model = cleanName(body?.model, 120) || models[engine]?.[0] || "";
        if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
        if (!name) { json(response, 400, { error: "agent-name-required" }); return; }
        if (!engine) { json(response, 400, { error: "unknown-engine" }); return; }
        const fingerprint = hashPayload({ projectId: project.id, name, engine, model });
        const receipt = receiptResult(receipts.agentCreates, key, fingerprint);
        if (receipt?.conflict) { json(response, 409, { error: "idempotency-key-conflict" }); return; }
        if (receipt?.replayed) {
          const agent = agents.get(receipt.id);
          json(response, agent ? 200 : 410, agent
            ? { ...publicAgent(agent), replayed: true }
            : { error: "idempotency-target-deleted" });
          return;
        }
        const agent = restoreAgent({
          id: randomUUID(),
          projectId: project.id,
          name,
          engine,
          model,
          sessionId: null,
          createdAt: now(),
          updatedAt: now(),
        });
        agent.hydrated = true;
        agents.set(agent.id, agent);
        project.updatedAt = now();
        rememberReceipt(receipts.agentCreates, key, { id: agent.id, hash: fingerprint });
        saveRegistry();
        json(response, 201, publicAgent(agent));
        return;
      }

      if (request.method === "POST" && projectMatch[2] === "/uploads") {
        const original = cleanName(url.searchParams.get("name"), 180);
        const extension = extname(original).toLowerCase();
        if (!original || !UPLOAD_EXTENSIONS.has(extension)) {
          json(response, 400, { error: "extension-not-allowed", allowed: [...UPLOAD_EXTENSIONS] });
          return;
        }
        const payload = await readRawBody(request, UPLOAD_MAX_BYTES);
        const projectUploadDir = join(uploadDir, project.id);
        mkdirSync(projectUploadDir, { recursive: true, mode: 0o700 });
        const path = join(projectUploadDir, `${randomUUID()}${extension}`);
        await writeFile(path, payload, { mode: 0o600 });
        json(response, 201, {
          path,
          name: original,
          bytes: payload.length,
          image: IMAGE_EXTENSIONS.has(extension),
          url: `/api/uploads/${project.id}/${encodeURIComponent(basename(path))}`,
        });
        return;
      }
    }

    const uploadMatch = pathname.match(new RegExp(`^/api/uploads/(${UUID_PATTERN})/([0-9a-f-]+\\.[a-z0-9]+)$`, "i"));
    if (request.method === "GET" && uploadMatch) {
      if (!projects.has(uploadMatch[1])) { json(response, 404, { error: "project-not-found" }); return; }
      const base = resolve(uploadDir, uploadMatch[1]);
      const path = resolve(base, uploadMatch[2]);
      if (!path.startsWith(`${base}${sep}`) || !existsSync(path) || !statSync(path).isFile()) {
        json(response, 404, { error: "upload-not-found" }); return;
      }
      const extension = extname(path).toLowerCase();
      const imageType = IMAGE_TYPES.get(extension);
      response.writeHead(200, publicHeaders({
        "content-type": imageType ?? "application/octet-stream",
        "content-length": statSync(path).size,
        "content-disposition": `${imageType ? "inline" : "attachment"}; filename="attachment${extension}"`,
      }));
      response.end(readFileSync(path));
      return;
    }

    const agentMatch = pathname.match(new RegExp(`^/api/agents/(${UUID_PATTERN})(/messages|/events|/history|/side-questions)?$`, "i"));
    if (agentMatch) {
      const agent = agents.get(agentMatch[1]);
      if (!agent) { json(response, 404, { error: "agent-not-found" }); return; }
      const project = projects.get(agent.projectId);

      if (request.method === "DELETE" && !agentMatch[2]) {
        if (agent.running) { json(response, 409, { error: "agent-running" }); return; }
        for (const client of agent.clients) client.end();
        agents.delete(agent.id);
        project.updatedAt = now();
        saveRegistry();
        json(response, 200, { deleted: true, sessionPreserved: true });
        return;
      }

      if (request.method === "POST" && agentMatch[2] === "/messages") {
        const body = await readJsonBody(request);
        const key = cleanName(body?.idempotencyKey, 160);
        const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 200_000) : "";
        const attachments = (Array.isArray(body?.attachments) ? body.attachments : [])
          .map((value) => attachmentFor(project.id, value))
          .filter(Boolean);
        if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
        if (!prompt) { json(response, 400, { error: "prompt-required" }); return; }
        if (attachments.length !== (body.attachments?.length ?? 0)) {
          json(response, 400, { error: "invalid-attachment" }); return;
        }
        const fingerprint = hashPayload({ agentId: agent.id, prompt, attachments: attachments.map((item) => item.path) });
        const receipt = receiptResult(receipts.messages, key, fingerprint);
        if (receipt?.conflict) { json(response, 409, { error: "idempotency-key-conflict" }); return; }
        if (receipt?.replayed) {
          json(response, 200, { ...publicAgent(agent), replayed: true });
          return;
        }
        if (agent.running) { json(response, 409, { error: "turn-in-progress" }); return; }
        rememberReceipt(receipts.messages, key, { id: agent.id, hash: fingerprint }, 1_000);
        saveRegistry();
        runTurn(agent, prompt, attachments);
        json(response, 202, publicAgent(agent));
        return;
      }

      if (request.method === "POST" && agentMatch[2] === "/side-questions") {
        const body = await readJsonBody(request);
        const key = cleanName(body?.idempotencyKey, 160);
        const question = typeof body?.question === "string" ? body.question.trim().slice(0, 20_000) : "";
        if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
        if (!question) { json(response, 400, { error: "side-question-required" }); return; }
        if (agent.engine !== "claude") { json(response, 400, { error: "side-question-claude-only" }); return; }
        if (!agent.sessionId) { json(response, 409, { error: "side-question-needs-session" }); return; }

        const fingerprint = hashPayload({ agentId: agent.id, sessionId: agent.sessionId, question });
        const existing = receipts.sideQuestions.get(key);
        if (existing && existing.hash !== fingerprint) {
          json(response, 409, { error: "idempotency-key-conflict" }); return;
        }
        if (existing?.status === "done") {
          json(response, 200, { answer: existing.result, replayed: true }); return;
        }

        let run = sideRuns.get(key);
        if (!run) {
          rememberReceipt(receipts.sideQuestions, key, {
            id: agent.id,
            hash: fingerprint,
            status: "running",
          }, 200);
          saveRegistry();
          run = runSideQuestion(agent, question)
            .then((answer) => {
              rememberReceipt(receipts.sideQuestions, key, {
                id: agent.id,
                hash: fingerprint,
                status: "done",
                result: answer.slice(0, 20_000),
              }, 200);
              saveRegistry();
              return answer;
            })
            .finally(() => sideRuns.delete(key));
          sideRuns.set(key, run);
        }
        try {
          const answer = await run;
          json(response, 200, { answer, replayed: Boolean(existing) });
        } catch (error) {
          receipts.sideQuestions.delete(key);
          saveRegistry();
          json(response, 502, { error: "side-question-failed", detail: error.message });
        }
        return;
      }

      if (request.method === "GET" && agentMatch[2] === "/history") {
        hydrate(agent);
        json(response, 200, { agent: publicAgent(agent), events: agent.events });
        return;
      }

      if (request.method === "GET" && agentMatch[2] === "/events") {
        hydrate(agent);
        response.writeHead(200, publicHeaders({
          "content-type": "text/event-stream; charset=utf-8",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        }));
        const lastEventId = String(request.headers["last-event-id"] || "");
        const [lastBootId, lastSequenceRaw] = lastEventId.split(":");
        const lastSequence = Number(lastSequenceRaw || 0);
        for (const event of agent.events) {
          const [, eventSequenceRaw] = String(event.webId).split(":");
          const eventSequence = Number(eventSequenceRaw || 0);
          if (lastBootId !== bootId || eventSequence > lastSequence) {
            response.write(`id: ${event.webId}\ndata: ${JSON.stringify(event)}\n\n`);
          }
        }
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        heartbeat.unref?.();
        agent.clients.add(response);
        request.on("close", () => {
          clearInterval(heartbeat);
          agent.clients.delete(response);
        });
        return;
      }
    }

    json(response, 404, { error: "route-not-found" });
  };

  const server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      json(response, error.status ?? 500, {
        error: error.message === "body-too-large" ? "body-too-large" : "internal-error",
      });
    });
  });

  const listen = ({
    port = Number(process.env.AMUX_WEB_PORT ?? process.env.SPIKE_PORT ?? 8811),
    host = "127.0.0.1",
  } = {}) => new Promise((resolveListen, rejectListen) => {
    if (!LOOPBACK_HOSTS.has(host)) {
      rejectListen(new Error("web-ui must bind to loopback; expose it with Tailscale Serve"));
      return;
    }
    const onError = (error) => rejectListen(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      resolveListen({
        host,
        port: typeof address === "object" ? address.port : port,
        url: `http://${host}:${typeof address === "object" ? address.port : port}`,
      });
    });
  });

  const close = () => new Promise((resolveClose) => {
    for (const agent of agents.values()) {
      try { agent.activeChild?.kill?.("SIGTERM"); } catch {}
      for (const client of agent.clients) client.end();
      agent.clients.clear();
    }
    for (const child of sideChildren) {
      try { child.kill?.("SIGTERM"); } catch {}
    }
    sideChildren.clear();
    if (!server.listening) { resolveClose(); return; }
    server.close(() => resolveClose());
  });

  return {
    server,
    listen,
    close,
    paths: { dataDir, registryPath, uploadDir },
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const app = createWebUi();
  app.listen().then(({ url }) => {
    console.log(`amux web-ui: ${url} (data ${app.paths.dataDir})`);
  }).catch((error) => {
    console.error(`amux web-ui failed: ${error.message}`);
    process.exitCode = 1;
  });
  const stop = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
