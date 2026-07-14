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
import {
  claudeInterruptRequest,
  claudeUserMessage,
  openCodexRpc,
  writeClaudeMessage,
} from "./runtime-control.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const JSON_MAX_BYTES = 256 * 1024;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const HISTORY_MAX_BYTES = 32 * 1024 * 1024;
const MEMORY_EVENT_LIMIT = 5_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const AUTO_COMPACT_CONTEXT_PERCENT = 60;
const AUTO_COMPACT_IDLE_MS = 5 * 60 * 1_000;

const DEFAULT_MODELS = Object.freeze({
  claude: ["claude-opus-4-8", "fable", "sonnet", "haiku"],
  codex: ["gpt-5.6-sol"],
});
const DEFAULT_EFFORTS = Object.freeze({
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
});
const DEFAULT_EFFORT = Object.freeze({ claude: "medium", codex: "medium" });

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

const agentIdentityFingerprint = ({
  projectId,
  name,
  engine,
  address,
  permissionMode,
}) => hashPayload({ projectId, name, engine, address, permissionMode });

const cleanName = (value, max = 64) => typeof value === "string"
  ? value.trim().replace(/\s+/g, " ").slice(0, max)
  : "";

const cleanEffort = (engine, value) => DEFAULT_EFFORTS[engine]?.includes(value)
  ? value
  : DEFAULT_EFFORT[engine];

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

const isClaudeHistoryNoise = (entry, text) => {
  const trimmed = text.trimStart();
  return entry.isMeta
    || entry.isSynthetic
    || entry.isReplay
    || trimmed.startsWith("[Request interrupted")
    || trimmed.startsWith("<local-command-caveat>")
    || trimmed.startsWith("<command-name>")
    || trimmed.startsWith("<local-command-stdout>")
    || trimmed.startsWith("This session is being continued from a previous conversation that ran out of context.");
};

const normalizeClaudeCompactMetadata = (metadata = {}) => ({
  trigger: metadata.trigger,
  pre_tokens: metadata.pre_tokens ?? metadata.preTokens,
  post_tokens: metadata.post_tokens ?? metadata.postTokens,
  cumulative_dropped_tokens: metadata.cumulative_dropped_tokens ?? metadata.cumulativeDroppedTokens,
  duration_ms: metadata.duration_ms ?? metadata.durationMs,
});

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

const cleanAddress = (value) => {
  if (value === undefined || value === null) return null;
  const session = typeof value?.session === "string" ? value.session.trim() : "";
  const pane = Number(value?.pane);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(session)
      || !Number.isSafeInteger(pane) || pane < 0 || pane > 999) return undefined;
  return { session, pane };
};

const cleanPermissionMode = (value) => value === "automation" ? "automation" : "interactive";

const cleanChildEnv = (agent = null) => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_)/i.test(key)) delete env[key];
  }
  delete env.CODEX_THREAD_ID;
  delete env.CODEX_CI;
  if (agent) {
    env.AMUX_NATIVE_RUNTIME = "1";
    env.AMUX_AGENT_ID = agent.id;
    if (agent.address) {
      env.AMUX_AGENT_NAME = agent.address.session;
      env.AMUX_PANE = String(agent.address.pane);
    }
  }
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
 * @param {number} [options.autoCompactContextPercent]
 * @param {number} [options.autoCompactIdleMs]
 * @param {Record<string, string | Buffer>} [options.staticAssets]
 */
export function createWebUi(options = {}) {
  const bootId = randomUUID();
  const homeDir = options.homeDir ?? homedir();
  const dataDir = resolve(options.dataDir
    ?? process.env.AMUX_WEB_DATA_DIR
    ?? join(homeDir, ".agentmux", "web-ui"));
  const legacyDataSetting = process.env.AMUX_WEB_LEGACY_DATA_DIR;
  const legacyDataDir = options.legacyDataDir === undefined
    ? String(legacyDataSetting || "").toLowerCase() === "off"
      ? null
      : legacyDataSetting ? resolve(legacyDataSetting) : join(ROOT, "data")
    : options.legacyDataDir;
  const registryPath = join(dataDir, "registry.json");
  const uploadDir = join(dataDir, "uploads");
  const spawnProcess = options.spawnProcess ?? spawn;
  const commands = {
    claude: options.claudeCommand ?? process.env.AMUX_WEB_CLAUDE_COMMAND ?? "claude",
    codex: options.codexCommand ?? process.env.AMUX_WEB_CODEX_COMMAND ?? "codex",
  };
  const autoCompactContextPercent = options.autoCompactContextPercent
    ?? AUTO_COMPACT_CONTEXT_PERCENT;
  const autoCompactIdleMs = options.autoCompactIdleMs ?? AUTO_COMPACT_IDLE_MS;
  const models = {
    claude: [...(options.models?.claude ?? DEFAULT_MODELS.claude)],
    codex: [...(options.models?.codex ?? DEFAULT_MODELS.codex)],
  };
  const staticAssets = new Map(["index.html", "app.js", "style.css"].map((file) => {
    const supplied = options.staticAssets?.[file];
    return [file, Buffer.from(supplied === undefined ? readFileSync(join(ROOT, file)) : supplied)];
  }));

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
    settings: new Map(),
    compactions: new Map(),
    interrupts: new Map(),
    uploads: new Map(),
  };
  const sideRuns = new Map();
  const sideChildren = new Set();

  const rememberReceipt = (map, key, value, limit = Number.POSITIVE_INFINITY) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  };

  const publicAgent = (agent) => {
    if (!agent.context && agent.sessionId) refreshContextFromSession(agent);
    if (!agent.running) scheduleAutoCompact(agent);
    const project = projects.get(agent.projectId);
    return {
      id: agent.id,
      projectId: agent.projectId,
      name: agent.name,
      engine: agent.engine,
      model: agent.model,
      effort: agent.effort,
      address: agent.address,
      permissionMode: agent.permissionMode,
      cwd: project?.cwd ?? null,
      sessionId: agent.sessionId,
      running: agent.running,
      operation: agent.interruptRequested ? "interrupting" : agent.operation,
      context: agent.context,
      idleSince: agent.idleSince,
      autoCompact: {
        contextPercent: autoCompactContextPercent,
        idleMs: autoCompactIdleMs,
        dueAt: agent.autoCompactDueAt,
      },
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
        effort: agent.effort,
        address: agent.address,
        permissionMode: agent.permissionMode,
        sessionId: agent.sessionId,
        context: agent.context,
        idleSince: agent.idleSince,
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
    effort: cleanEffort(entry.engine, entry.effort),
    address: cleanAddress(entry.address) ?? null,
    permissionMode: cleanPermissionMode(entry.permissionMode),
    sessionId: entry.sessionId ?? null,
    context: entry.context ?? null,
    createdAt: entry.createdAt ?? now(),
    updatedAt: entry.updatedAt ?? entry.createdAt ?? now(),
    idleSince: entry.idleSince ?? entry.updatedAt ?? entry.createdAt ?? now(),
    running: false,
    operation: null,
    activeChild: null,
    activeControl: null,
    activeTurnId: null,
    activeOperationKey: null,
    interruptRequested: false,
    autoCompactTimer: null,
    autoCompactDueAt: null,
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
    let upgradedAgentReceipts = false;
    for (const receipt of receipts.agentCreates.values()) {
      const agent = agents.get(receipt.id);
      if (!agent) continue;
      const identityHash = agentIdentityFingerprint(agent);
      if (receipt.hash === identityHash) continue;
      receipt.hash = identityHash;
      upgradedAgentReceipts = true;
    }
    if (upgradedAgentReceipts) saveRegistry();
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

  const percentOf = (usedTokens, windowTokens) => Number.isFinite(usedTokens)
      && Number.isFinite(windowTokens)
      && windowTokens > 0
    ? Math.min(100, Math.max(0, (usedTokens / windowTokens) * 100))
    : null;

  const claudeUsageParts = (usage = {}) => {
    const inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? 0)
      + Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0)
      + Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? 0);
    return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  };

  const contextFromClaudeResult = (event, previous = null) => {
    const usageEntries = Object.values(event.modelUsage ?? {});
    const modelUsage = usageEntries.find((entry) => Number.isFinite(entry?.contextWindow))
      ?? usageEntries[0]
      ?? null;
    const iterations = Array.isArray(event.usage?.iterations) ? event.usage.iterations : [];
    const parts = claudeUsageParts(iterations.at(-1) ?? event.usage ?? modelUsage);
    const processed = claudeUsageParts(modelUsage ?? event.usage);
    const windowTokens = Number(modelUsage?.contextWindow ?? previous?.windowTokens ?? 0) || null;
    return {
      usedTokens: parts.totalTokens,
      windowTokens,
      percent: percentOf(parts.totalTokens, windowTokens),
      lastInputTokens: parts.inputTokens,
      lastOutputTokens: parts.outputTokens,
      processedTokens: Number(previous?.processedTokens ?? 0) + processed.totalTokens,
      updatedAt: now(),
    };
  };

  const contextFromCodexUsage = (tokenUsage, previous = null) => {
    const last = tokenUsage?.last ?? tokenUsage?.last_token_usage ?? {};
    const total = tokenUsage?.total ?? tokenUsage?.total_token_usage ?? {};
    const usedTokens = Number(last.totalTokens ?? last.total_tokens ?? 0);
    const windowTokens = Number(tokenUsage?.modelContextWindow
      ?? tokenUsage?.model_context_window
      ?? previous?.windowTokens
      ?? 0) || null;
    return {
      usedTokens,
      windowTokens,
      percent: percentOf(usedTokens, windowTokens),
      lastInputTokens: Number(last.inputTokens ?? last.input_tokens ?? 0),
      lastOutputTokens: Number(last.outputTokens ?? last.output_tokens ?? 0),
      processedTokens: Number(total.totalTokens ?? total.total_tokens ?? previous?.processedTokens ?? 0),
      updatedAt: now(),
    };
  };

  const refreshContextFromSession = (agent) => {
    const path = sessionFileFor(agent);
    if (!path || !existsSync(path)) return agent.context;
    const lines = readTailWindow(path, HISTORY_MAX_BYTES).text.split("\n");
    if (agent.engine === "codex") {
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const entry = JSON.parse(lines[index]);
          if (entry.type === "event_msg" && entry.payload?.type === "token_count" && entry.payload.info) {
            agent.context = contextFromCodexUsage(entry.payload.info, agent.context);
            return agent.context;
          }
        } catch {}
      }
      return agent.context;
    }

    let lastContext = null;
    let lastUsageIndex = -1;
    let lastCompact = null;
    let lastCompactIndex = -1;
    const messageUsage = new Map();
    for (let index = 0; index < lines.length; index += 1) {
      try {
        const entry = JSON.parse(lines[index]);
        if (entry.type === "assistant" && entry.message?.usage
            && entry.message.model !== "<synthetic>" && !entry.isSynthetic && !entry.isReplay) {
          const messageId = entry.message.id ?? `${index}`;
          messageUsage.set(messageId, claudeUsageParts(entry.message.usage));
          const modelUsage = {
            ...entry.message.usage,
            contextWindow: agent.context?.windowTokens ?? null,
          };
          lastContext = contextFromClaudeResult({ modelUsage: { [entry.message.model ?? "claude"]: modelUsage } }, {
            ...agent.context,
            processedTokens: 0,
          });
          lastUsageIndex = index;
        } else if (entry.type === "system" && entry.subtype === "compact_boundary"
            && (entry.compact_metadata || entry.compactMetadata)) {
          lastCompact = normalizeClaudeCompactMetadata(entry.compact_metadata ?? entry.compactMetadata);
          lastCompactIndex = index;
        }
      } catch {}
    }
    if (lastContext) {
      lastContext.processedTokens = [...messageUsage.values()]
        .reduce((total, item) => total + item.totalTokens, 0);
      if (lastCompact && lastCompactIndex > lastUsageIndex) {
        lastContext.usedTokens = Number(lastCompact.post_tokens ?? lastContext.usedTokens);
        lastContext.percent = percentOf(lastContext.usedTokens, lastContext.windowTokens);
      }
      agent.context = lastContext;
    }
    return agent.context;
  };

  const pushEvent = (agent, event) => {
    const numericAt = Number(event.at);
    const parsedAt = typeof event.at === "string" ? Date.parse(event.at) : NaN;
    event.at = Number.isFinite(numericAt) && numericAt > 0
      ? numericAt
      : Number.isFinite(parsedAt) ? parsedAt : now();
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
    const receiptMatches = [...receipts.messages.entries()]
      .filter(([, receipt]) => receipt?.id === agent.id && Array.isArray(receipt.promptHashes))
      .map(([operationKey, receipt]) => ({ operationKey, receipt }));
    const usedReceiptKeys = new Set();
    const operationKeyForPrompt = (text, eventAt) => {
      const promptHash = hashPayload({ agentId: agent.id, prompt: text });
      const numericAt = Number(eventAt);
      const parsedAt = typeof eventAt === "string" ? Date.parse(eventAt) : NaN;
      const eventTime = Number.isFinite(numericAt) && numericAt > 0
        ? numericAt
        : Number.isFinite(parsedAt) ? parsedAt : null;
      const candidates = receiptMatches.filter(({ operationKey, receipt }) =>
        !usedReceiptKeys.has(operationKey) && receipt.promptHashes.includes(promptHash));
      if (eventTime != null) {
        candidates.sort((left, right) => {
          const leftDistance = Number.isFinite(left.receipt.acceptedAt)
            ? Math.abs(left.receipt.acceptedAt - eventTime) : Number.POSITIVE_INFINITY;
          const rightDistance = Number.isFinite(right.receipt.acceptedAt)
            ? Math.abs(right.receipt.acceptedAt - eventTime) : Number.POSITIVE_INFINITY;
          return leftDistance - rightDistance;
        });
      }
      const match = candidates[0];
      if (!match) return null;
      usedReceiptKeys.add(match.operationKey);
      return match.operationKey;
    };
    let turnOpen = false;
    let turnHasAssistant = false;
    let turnTerminal = false;
    let turnAt = 0;
    let turnOperationKey = null;
    const closeHydratedTurn = () => {
      if (turnOpen && turnHasAssistant) {
        pushEvent(agent, {
          type: "web",
          subtype: "turn-done",
          code: 0,
          historical: true,
          at: turnAt,
          operationKey: turnOperationKey,
        });
      }
      turnOpen = false;
      turnHasAssistant = false;
      turnTerminal = false;
      turnOperationKey = null;
    };
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (agent.engine === "claude") {
        if (entry.type === "user") {
          const text = textOf(entry.message?.content);
          if (text && !isClaudeHistoryNoise(entry, text) && !isEngineNoise(text)) {
            closeHydratedTurn();
            turnOperationKey = operationKeyForPrompt(text, entry.timestamp);
            pushEvent(agent, {
              type: "web",
              subtype: "user",
              text,
              at: entry.timestamp ?? 0,
              operationKey: turnOperationKey,
            });
            turnOpen = true;
            turnAt = entry.timestamp ?? 0;
          }
        } else if (entry.type === "assistant" && entry.message?.model !== "<synthetic>"
            && !entry.isSynthetic && !entry.isReplay) {
          const content = Array.isArray(entry.message?.content)
            ? entry.message.content
            : [{ type: "text", text: textOf(entry.message?.content) }];
          const hasTool = content.some((block) => block?.type === "tool_use");
          if (textOf(content) || hasTool) pushEvent(agent, {
            type: "assistant",
            message: { ...entry.message, content },
            at: entry.timestamp ?? 0,
          });
          turnHasAssistant = turnHasAssistant || Boolean(textOf(content)) || hasTool;
          turnTerminal = turnTerminal || ["end_turn", "stop_sequence", "max_tokens", "refusal"]
            .includes(entry.message?.stop_reason);
          turnAt = entry.timestamp ?? turnAt;
        } else if (entry.type === "system" && entry.subtype === "compact_boundary"
            && (entry.compact_metadata || entry.compactMetadata)) {
          pushEvent(agent, {
            type: "web",
            subtype: "compacted",
            metadata: normalizeClaudeCompactMetadata(entry.compact_metadata ?? entry.compactMetadata),
            at: entry.timestamp ?? 0,
          });
        }
      } else if (entry.type === "response_item" && entry.payload?.type === "message") {
        const text = textOf(entry.payload.content);
        if (!text || isEngineNoise(text)) continue;
        if (entry.payload.role === "user") {
          closeHydratedTurn();
          turnOperationKey = operationKeyForPrompt(text, entry.timestamp);
          pushEvent(agent, {
            type: "web",
            subtype: "user",
            text,
            at: entry.timestamp ?? 0,
            operationKey: turnOperationKey,
          });
          turnOpen = true;
          turnAt = entry.timestamp ?? 0;
        } else if (entry.payload.role === "assistant") {
          pushEvent(agent, {
            type: "assistant",
            message: { content: [{ type: "text", text }] },
            at: entry.timestamp ?? 0,
          });
          turnHasAssistant = true;
          turnAt = entry.timestamp ?? turnAt;
        }
      } else if (agent.engine === "codex" && entry.type === "event_msg"
          && ["task_complete", "turn_aborted"].includes(entry.payload?.type)) {
        turnTerminal = true;
        turnAt = entry.timestamp ?? turnAt;
        closeHydratedTurn();
      }
    }
    if (turnTerminal) closeHydratedTurn();
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

  const buildClaudeLaunch = (agent, rawPrompt, attachments) => {
    const prompt = attachmentPrompt(rawPrompt, attachments);
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", agent.model,
      "--effort", agent.effort,
      "--name", agent.name,
    ];
    if (agent.permissionMode === "automation") args.push("--dangerously-skip-permissions");
    else args.push("--permission-mode", "acceptEdits");
    if (agent.sessionId) args.push("--resume", agent.sessionId);
    return { command: commands.claude, args, prompt };
  };

  const buildCodexInput = (rawPrompt, attachments) => {
    const images = attachments.filter((attachment) => attachment.image);
    const otherFiles = attachments.filter((attachment) => !attachment.image);
    return [
      { type: "text", text: attachmentPrompt(rawPrompt, otherFiles) },
      ...images.map((image) => ({ type: "localImage", path: image.path })),
    ];
  };

  const recordSessionId = (agent, sessionId) => {
    if (!sessionId || sessionId === agent.sessionId) return;
    agent.sessionId = sessionId;
    agent.updatedAt = now();
    saveRegistry();
  };

  const clearAutoCompact = (agent) => {
    clearTimeout(agent.autoCompactTimer);
    agent.autoCompactTimer = null;
    agent.autoCompactDueAt = null;
  };

  const setAgentContext = (agent, context, emit = true) => {
    agent.context = context;
    if (emit) webEvent(agent, "context", { context });
  };

  const beginOperation = (agent, operation, rawPrompt = "", attachments = [], operationKey = null) => {
    const project = projects.get(agent.projectId);
    hydrate(agent);
    clearAutoCompact(agent);
    agent.running = true;
    agent.operation = operation;
    agent.interruptRequested = false;
    agent.activeTurnId = null;
    agent.activeOperationKey = operationKey;
    agent.turnHasAssistantText = false;
    agent.compactMetadata = null;
    agent.updatedAt = now();
    if (operation === "turn") {
      webEvent(agent, "user", {
        text: rawPrompt,
        attachments: attachments.map((attachment) => publicAttachment(project.id, attachment)),
        operationKey,
      });
    } else {
      webEvent(agent, "compact-start", {
        automatic: operation === "auto-compact",
        operationKey,
      });
    }
  };

  const finishOperation = (agent, operation, code, error = null, stderr = "") => {
    if (!agent.running || agent.operation !== operation) return;
    const control = agent.activeControl;
    agent.running = false;
    agent.operation = null;
    agent.activeChild = null;
    agent.activeControl = null;
    agent.activeTurnId = null;
    const operationKey = agent.activeOperationKey;
    agent.activeOperationKey = null;
    agent.updatedAt = now();
    agent.idleSince = agent.updatedAt;
    agent.events = agent.events.filter((event) => event.type !== "stream_event");
    if (agent.engine === "codex") control?.rpc?.close?.();
    const interrupted = agent.interruptRequested;
    agent.interruptRequested = false;
    saveRegistry();
    if (operation === "turn") {
      webEvent(agent, "turn-done", {
        code,
        interrupted,
        error: error?.message,
        stderr: code === 0 || interrupted ? undefined : stderr.slice(-32_000),
        operationKey,
      });
    } else {
      webEvent(agent, "compact-done", {
        code,
        automatic: operation === "auto-compact",
        interrupted,
        error: error?.message,
        stderr: code === 0 || interrupted ? undefined : stderr.slice(-32_000),
        metadata: agent.compactMetadata,
        operationKey,
      });
    }
    scheduleAutoCompact(agent);
  };

  const mapClaudeEvent = (agent, event) => {
    recordSessionId(agent, event.session_id);
    const operation = agent.operation;
    if (event.type === "control_response"
        && event.response?.subtype === "success") {
      webEvent(agent, "interrupt-acknowledged");
      return;
    }
    if (event.type === "system" && event.subtype === "compact_boundary") {
      const metadata = normalizeClaudeCompactMetadata(event.compact_metadata ?? event.compactMetadata);
      agent.compactMetadata = metadata;
      const usedTokens = Number(metadata.post_tokens ?? agent.context?.usedTokens ?? 0);
      const context = {
        ...(agent.context ?? {}),
        usedTokens,
        percent: percentOf(usedTokens, agent.context?.windowTokens),
        updatedAt: now(),
      };
      setAgentContext(agent, context);
      webEvent(agent, "compacted", { metadata });
      return;
    }
    if (event.type === "stream_event"
        && operation === "turn"
        && event.event?.type === "content_block_delta"
        && event.event.delta?.type === "text_delta") {
      broadcast(agent, event);
      return;
    }
    if (event.type === "assistant" && operation === "turn" && !agent.interruptRequested) {
      const text = textOf(event.message?.content);
      const hasTool = Array.isArray(event.message?.content)
        && event.message.content.some((block) => block?.type === "tool_use");
      if (text || hasTool) {
        if (text) agent.turnHasAssistantText = true;
        broadcast(agent, event);
      }
      return;
    }
    if (event.type !== "result") return;

    if (operation === "turn" && !agent.interruptRequested) {
      setAgentContext(agent, contextFromClaudeResult(event, agent.context));
      if (!agent.turnHasAssistantText && typeof event.result === "string" && event.result.trim()) {
        agent.turnHasAssistantText = true;
        broadcast(agent, {
          type: "assistant",
          message: { content: [{ type: "text", text: event.result }] },
        });
      }
      broadcast(agent, event);
    } else if (agent.interruptRequested) {
      webEvent(agent, "interrupted");
    } else if (!agent.compactMetadata && typeof event.result === "string" && event.result.trim()) {
      webEvent(agent, "compact-result", { message: event.result.trim() });
    }
    try { agent.activeChild?.stdin?.end?.(); } catch {}
  };

  const runClaudeOperation = (agent, rawPrompt, attachments, operation, operationKey = null) => {
    const project = projects.get(agent.projectId);
    const launch = buildClaudeLaunch(agent, rawPrompt, attachments);
    beginOperation(agent, operation, rawPrompt, attachments, operationKey);
    let child;
    let stderr = "";
    let finished = false;
    const finish = (code, error = null) => {
      if (finished) return;
      finished = true;
      finishOperation(agent, operation, code, error, stderr);
    };
    try {
      child = spawnProcess(launch.command, launch.args, {
        cwd: project.cwd,
        env: cleanChildEnv(agent),
        stdio: ["pipe", "pipe", "pipe"],
      });
      agent.activeChild = child;
      agent.activeControl = { type: "claude", child };
    } catch (error) {
      finish(-1, error);
      return;
    }
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); });
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (!line.trim()) return;
        try { mapClaudeEvent(agent, JSON.parse(line)); } catch {
          webEvent(agent, "protocol-error", { line: line.slice(0, 4_000) });
        }
      });
    }
    child.once?.("error", (error) => finish(-1, error));
    child.once?.("close", (code) => finish(Number.isInteger(code) ? code : -1));
    try {
      writeClaudeMessage(child, claudeUserMessage(launch.prompt));
    } catch (error) {
      finish(-1, error);
      try { child.kill?.("SIGTERM"); } catch {}
    }
  };

  const runCodexOperation = async (agent, rawPrompt, attachments, operation, operationKey = null) => {
    const project = projects.get(agent.projectId);
    const effort = agent.effort;
    beginOperation(agent, operation, rawPrompt, attachments, operationKey);
    let stderr = "";
    let finished = false;
    const finish = (code, error = null) => {
      if (finished) return;
      finished = true;
      finishOperation(agent, operation, code, error, stderr);
    };
    const onNotification = (message) => {
      const { method, params = {} } = message;
      if (method === "protocol/error") {
        webEvent(agent, "protocol-error", { line: params.line });
      } else if (method === "thread/tokenUsage/updated" && params.tokenUsage) {
        setAgentContext(agent, contextFromCodexUsage(params.tokenUsage, agent.context));
      } else if (method === "turn/started" && params.turn?.id) {
        agent.activeTurnId = params.turn.id;
      } else if (method === "item/agentMessage/delta" && operation === "turn") {
        broadcast(agent, {
          type: "stream_event",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: params.delta ?? "" } },
        });
      } else if (method === "item/completed" && params.item?.type === "agentMessage" && operation === "turn") {
        agent.turnHasAssistantText = true;
        broadcast(agent, {
          type: "assistant",
          message: { content: [{ type: "text", text: params.item.text ?? "" }] },
        });
      } else if (method === "item/completed" && operation === "turn"
          && ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(params.item?.type)) {
        const item = params.item;
        const tool = item.type === "commandExecution"
          ? { name: "exec_command", input: { cmd: item.command || item.commandLine || "command" } }
          : item.type === "fileChange"
            ? { name: "apply_patch", input: { path: item.path || item.filePath || "files" } }
            : item.type === "webSearch"
              ? { name: "web_search", input: { query: item.query || "" } }
              : { name: item.tool || item.name || "mcp_tool", input: item.arguments || item.input || {} };
        broadcast(agent, {
          type: "assistant",
          message: { content: [{ type: "tool_use", ...tool }] },
        });
      } else if (method === "item/completed" && params.item?.type === "contextCompaction") {
        webEvent(agent, "compacted", { metadata: null });
      } else if (method === "turn/completed") {
        const status = params.turn?.status ?? "completed";
        if (operation === "turn" && !agent.interruptRequested) {
          broadcast(agent, {
            type: "result",
            subtype: status === "completed" ? "success" : status,
            engine: "codex",
            usage: agent.context ? {
              input_tokens: agent.context.lastInputTokens,
              output_tokens: agent.context.lastOutputTokens,
            } : null,
            session_id: agent.sessionId,
            duration_ms: params.turn?.durationMs,
          });
        } else if (agent.interruptRequested) {
          webEvent(agent, "interrupted");
        }
        finish(["completed", "interrupted"].includes(status) ? 0 : 1,
          status === "failed" ? new Error(params.turn?.error?.message ?? "codex-turn-failed") : null);
      }
    };

    let rpc;
    try {
      rpc = openCodexRpc({
        spawnProcess,
        command: commands.codex,
        cwd: project.cwd,
        env: cleanChildEnv(agent),
        onNotification,
        onStderr: (chunk) => { stderr = `${stderr}${chunk}`.slice(-32_000); },
        onExit: (code) => finish(Number.isInteger(code) ? code : -1,
          finished ? null : new Error(`codex-app-server-exit-${code ?? "unknown"}`)),
      });
      agent.activeChild = rpc.child;
      agent.activeControl = { type: "codex", rpc };
      await rpc.initialize();
      const codexPolicy = agent.permissionMode === "automation"
        ? { sandbox: "danger-full-access", approvalPolicy: "never" }
        : {};
      const turnPolicy = agent.permissionMode === "automation"
        ? { sandboxPolicy: { type: "dangerFullAccess" }, approvalPolicy: "never" }
        : {};
      const threadResult = agent.sessionId
        ? await rpc.request("thread/resume", {
          threadId: agent.sessionId,
          cwd: project.cwd,
          model: agent.model,
          ...codexPolicy,
        })
        : await rpc.request("thread/start", {
          cwd: project.cwd,
          model: agent.model,
          ...codexPolicy,
        });
      const threadId = threadResult?.thread?.id ?? agent.sessionId;
      if (!threadId) throw new Error("codex-thread-id-missing");
      recordSessionId(agent, threadId);
      if (operation === "compact" || operation === "auto-compact") {
        await rpc.request("thread/compact/start", { threadId });
      } else {
        const result = await rpc.request("turn/start", {
          threadId,
          input: buildCodexInput(rawPrompt, attachments),
          cwd: project.cwd,
          model: agent.model,
          effort,
          ...turnPolicy,
        });
        agent.activeTurnId = result?.turn?.id ?? agent.activeTurnId;
      }
    } catch (error) {
      finish(-1, error);
    }
  };

  const runTurn = (agent, rawPrompt, attachments, operationKey = null) => {
    if (agent.engine === "claude") {
      runClaudeOperation(agent, rawPrompt, attachments, "turn", operationKey);
    } else {
      void runCodexOperation(agent, rawPrompt, attachments, "turn", operationKey);
    }
  };

  const runCompact = (agent, automatic = false, operationKey = null, focus = "") => {
    const operation = automatic ? "auto-compact" : "compact";
    const claudeCommand = focus ? `/compact ${focus}` : "/compact";
    if (agent.engine === "claude") {
      runClaudeOperation(agent, claudeCommand, [], operation, operationKey);
    } else {
      void runCodexOperation(agent, "", [], operation, operationKey);
    }
  };

  const scheduleAutoCompact = (agent) => {
    clearAutoCompact(agent);
    if (agent.running || !agent.sessionId || !Number.isFinite(agent.context?.percent)
        || agent.context.percent < autoCompactContextPercent) return;
    const dueAt = Math.max(now(), Number(agent.idleSince ?? now()) + autoCompactIdleMs);
    agent.autoCompactDueAt = dueAt;
    agent.autoCompactTimer = setTimeout(() => {
      agent.autoCompactTimer = null;
      agent.autoCompactDueAt = null;
      if (agent.running || !Number.isFinite(agent.context?.percent)
          || agent.context.percent < autoCompactContextPercent) return;
      runCompact(agent, true);
    }, Math.max(0, dueAt - now()));
    agent.autoCompactTimer.unref?.();
  };

  const interruptAgent = async (agent) => {
    if (!agent.running || !agent.activeControl) throw new Error("agent-not-running");
    agent.interruptRequested = true;
    webEvent(agent, "interrupt-requested");
    try {
      if (agent.activeControl.type === "claude") {
        writeClaudeMessage(agent.activeControl.child, claudeInterruptRequest());
        return;
      }
      if (!agent.activeTurnId) throw new Error("interrupt-not-ready");
      await agent.activeControl.rpc.request("turn/interrupt", {
        threadId: agent.sessionId,
        turnId: agent.activeTurnId,
      });
      webEvent(agent, "interrupt-acknowledged");
    } catch (error) {
      agent.interruptRequested = false;
      webEvent(agent, "interrupt-failed", { error: error.message });
      throw error;
    }
  };

  for (const agent of agents.values()) {
    if (agent.sessionId) refreshContextFromSession(agent);
    scheduleAutoCompact(agent);
  }

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
      "--effort", agent.effort,
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
        env: cleanChildEnv(agent),
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
    response.end(staticAssets.get(file));
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
        bootId,
        models,
        efforts: DEFAULT_EFFORTS,
        defaultEffort: DEFAULT_EFFORT,
        autoCompact: {
          contextPercent: autoCompactContextPercent,
          idleMs: autoCompactIdleMs,
        },
        limits: { uploadMaxBytes: UPLOAD_MAX_BYTES, uploadExtensions: [...UPLOAD_EXTENSIONS] },
        communicationPolicy: defaultCommunicationPolicy(),
        authBoundary: "loopback-tailnet",
      });
      return;
    }

    if (request.method === "GET" && pathname === "/api/health") {
      json(response, 200, {
        ok: true,
        bootId,
        projects: projects.size,
        agents: agents.size,
        running: [...agents.values()].filter((agent) => agent.running).length,
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
          clearAutoCompact(agent);
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
        const address = cleanAddress(body?.address);
        const permissionMode = cleanPermissionMode(body?.permissionMode);
        if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
        if (!name) { json(response, 400, { error: "agent-name-required" }); return; }
        if (!engine) { json(response, 400, { error: "unknown-engine" }); return; }
        if (address === undefined) { json(response, 400, { error: "invalid-agent-address" }); return; }
        if (body?.effort !== undefined && !DEFAULT_EFFORTS[engine].includes(body.effort)) {
          json(response, 400, { error: "unknown-effort", allowed: DEFAULT_EFFORTS[engine] }); return;
        }
        const effort = cleanEffort(engine, body?.effort);
        const fingerprint = agentIdentityFingerprint({
          projectId: project.id,
          name,
          engine,
          address,
          permissionMode,
        });
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
          effort,
          address,
          permissionMode,
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
        const key = cleanName(request.headers["x-idempotency-key"], 160);
        const extension = extname(original).toLowerCase();
        if (!key) {
          json(response, 400, { error: "idempotency-key-required" });
          return;
        }
        if (!original || !UPLOAD_EXTENSIONS.has(extension)) {
          json(response, 400, { error: "extension-not-allowed", allowed: [...UPLOAD_EXTENSIONS] });
          return;
        }
        const payload = await readRawBody(request, UPLOAD_MAX_BYTES);
        const fingerprint = hashPayload({
          projectId: project.id,
          original,
          bytes: payload.length,
          sha256: createHash("sha256").update(payload).digest("hex"),
        });
        const prior = receipts.uploads.get(key);
        if (prior && prior.hash !== fingerprint) {
          json(response, 409, { error: "idempotency-key-conflict" });
          return;
        }
        if (prior) {
          const path = prior.id;
          if (!existsSync(path)) {
            json(response, 410, { error: "idempotency-target-deleted" });
            return;
          }
          json(response, 200, {
            path,
            name: original,
            bytes: statSync(path).size,
            image: IMAGE_EXTENSIONS.has(extension),
            url: `/api/uploads/${project.id}/${encodeURIComponent(basename(path))}`,
            replayed: true,
          });
          return;
        }
        const projectUploadDir = join(uploadDir, project.id);
        mkdirSync(projectUploadDir, { recursive: true, mode: 0o700 });
        const path = join(projectUploadDir, `${randomUUID()}${extension}`);
        await writeFile(path, payload, { mode: 0o600 });
        rememberReceipt(receipts.uploads, key, { id: path, hash: fingerprint }, 2_000);
        saveRegistry();
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

    const agentMatch = pathname.match(new RegExp(`^/api/agents/(${UUID_PATTERN})(/messages|/events|/history|/side-questions|/compact|/interrupt)?$`, "i"));
    if (agentMatch) {
      const agent = agents.get(agentMatch[1]);
      if (!agent) { json(response, 404, { error: "agent-not-found" }); return; }
      const project = projects.get(agent.projectId);

      if (request.method === "PATCH" && !agentMatch[2]) {
        const body = await readJsonBody(request);
        const key = cleanName(body?.idempotencyKey, 160);
        if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
        const hasEffort = body?.effort !== undefined;
        const hasModel = body?.model !== undefined;
        if (!hasEffort && !hasModel) {
          json(response, 400, { error: "setting-required" }); return;
        }
        if (hasEffort && !DEFAULT_EFFORTS[agent.engine].includes(body.effort)) {
          json(response, 400, { error: "unknown-effort", allowed: DEFAULT_EFFORTS[agent.engine] }); return;
        }
        const model = hasModel ? cleanName(body.model, 120) : agent.model;
        if (!model) { json(response, 400, { error: "model-required" }); return; }
        const effort = hasEffort ? body.effort : agent.effort;
        const fingerprint = hashPayload({ agentId: agent.id, effort, model });
        const receipt = receiptResult(receipts.settings, key, fingerprint);
        if (receipt?.conflict) { json(response, 409, { error: "idempotency-key-conflict" }); return; }
        if (receipt?.replayed) {
          json(response, 200, { ...publicAgent(agent), replayed: true });
          return;
        }
        agent.effort = effort;
        agent.model = model;
        agent.updatedAt = now();
        project.updatedAt = agent.updatedAt;
        rememberReceipt(receipts.settings, key, { id: agent.id, hash: fingerprint }, 500);
        saveRegistry();
        webEvent(agent, "settings", {
          effort: agent.effort,
          model: agent.model,
          appliesTo: "next-turn",
        });
        json(response, 200, publicAgent(agent));
        return;
      }

      if (request.method === "DELETE" && !agentMatch[2]) {
        if (agent.running) { json(response, 409, { error: "agent-running" }); return; }
        clearAutoCompact(agent);
        for (const client of agent.clients) client.end();
        agents.delete(agent.id);
        project.updatedAt = now();
        saveRegistry();
        json(response, 200, { deleted: true, sessionPreserved: true });
        return;
      }

      if (request.method === "POST" && agentMatch[2] === "/compact") {
        const body = await readJsonBody(request);
        const key = cleanName(body?.idempotencyKey, 160);
        const focus = typeof body?.focus === "string" ? body.focus.trim().slice(0, 20_000) : "";
        if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
        if (!agent.sessionId) { json(response, 409, { error: "compact-needs-session" }); return; }
        const fingerprint = hashPayload({
          agentId: agent.id,
          sessionId: agent.sessionId,
          action: "compact",
          focus,
        });
        const receipt = receiptResult(receipts.compactions, key, fingerprint);
        if (receipt?.conflict) { json(response, 409, { error: "idempotency-key-conflict" }); return; }
        if (receipt?.replayed) {
          json(response, 200, { ...publicAgent(agent), replayed: true });
          return;
        }
        if (agent.running) { json(response, 409, { error: "turn-in-progress" }); return; }
        rememberReceipt(receipts.compactions, key, { id: agent.id, hash: fingerprint }, 500);
        saveRegistry();
        runCompact(agent, false, key, focus);
        json(response, 202, publicAgent(agent));
        return;
      }

      if (request.method === "POST" && agentMatch[2] === "/interrupt") {
        const body = await readJsonBody(request);
        const key = cleanName(body?.idempotencyKey, 160);
        if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
        const fingerprint = hashPayload({
          agentId: agent.id,
          action: "interrupt",
        });
        const receipt = receiptResult(receipts.interrupts, key, fingerprint);
        if (receipt?.conflict) { json(response, 409, { error: "idempotency-key-conflict" }); return; }
        if (receipt?.replayed) {
          json(response, 200, { ...publicAgent(agent), replayed: true });
          return;
        }
        if (!agent.running) { json(response, 409, { error: "agent-not-running" }); return; }
        try {
          await interruptAgent(agent);
          rememberReceipt(receipts.interrupts, key, { id: agent.id, hash: fingerprint }, 500);
          saveRegistry();
          json(response, 202, publicAgent(agent));
        } catch (error) {
          json(response, error.message === "interrupt-not-ready" ? 409 : 502, {
            error: error.message,
          });
        }
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
        const enginePrompt = agent.engine === "claude"
          ? attachmentPrompt(prompt, attachments)
          : attachmentPrompt(prompt, attachments.filter((attachment) => !attachment.image));
        rememberReceipt(receipts.messages, key, {
          id: agent.id,
          hash: fingerprint,
          promptHashes: [...new Set([prompt, enginePrompt]
            .map((value) => hashPayload({ agentId: agent.id, prompt: value })))],
          acceptedAt: now(),
        }, 1_000);
        saveRegistry();
        runTurn(agent, prompt, attachments, key);
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
        json(response, 200, { bootId, agent: publicAgent(agent), events: agent.events });
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
      clearAutoCompact(agent);
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
