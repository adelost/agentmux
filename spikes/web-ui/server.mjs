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
import { appendEvent as appendFleetEvent } from "../../core/events.mjs";
import { readTailWindow } from "../../core/jsonl-reader.mjs";
import { readQuotaSnapshot } from "../../core/quota-usage.mjs";
import { createNativeClaudeQuotaController } from "../../core/native-claude-quota.mjs";
import { ensureCodexExecutionSafety } from "../../core/codex-profiles.mjs";
import { persistedSessionIdentity } from "../../core/native-session-identity.mjs";
import { shouldStopPane } from "../../core/model-watch.mjs";
import {
  describeModelObservation,
  latestCodexModelObservation,
  observationFromClaudeEvent,
  observationFromCodexReroute,
} from "../../core/native-model-observation.mjs";
import {
  CODEX_AUTONOMOUS_THREAD_POLICY,
  CODEX_AUTONOMOUS_TURN_POLICY,
} from "../../core/execution-safety.mjs";
import {
  claudeInterruptRequest,
  claudeUserMessage,
  openCodexRpc,
  writeClaudeMessage,
} from "./runtime-control.mjs";
import { attachmentPrompt, buildNativeClaudeLaunch, buildNativeCodexInput } from "./runtime-prompt.mjs";
const ROOT = dirname(fileURLToPath(import.meta.url));
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const JSON_MAX_BYTES = 256 * 1024;
const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
const HISTORY_MAX_BYTES = 32 * 1024 * 1024;
const MEMORY_EVENT_LIMIT = 5_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const AUTO_COMPACT_CONTEXT_PERCENT = 60;
const AUTO_COMPACT_IDLE_MS = 5 * 60 * 1_000;
const OPERATION_TIME_MATCH_MS = 5 * 60 * 1_000;
const PROMPT_PREVIEW_MAX_CHARS = 500;
const TOOL_SUMMARY_MAX_CHARS = 600;
const TOOL_RESULT_MAX_CHARS = 1_200;
const PROMPT_JOURNAL_DEFAULT_LIMIT = 100;
const PROMPT_JOURNAL_MAX_LIMIT = 500;
const MESSAGE_QUEUE_MAX_PER_AGENT = 100;
const QUOTA_CACHE_MS = 60 * 1_000;

let quotaCache = { at: 0, payload: null };

const DEFAULT_MODELS = Object.freeze({
  claude: ["claude-opus-4-8", "fable", "sonnet", "haiku"],
  codex: ["gpt-5.6-sol"],
});
const DEFAULT_EFFORTS = Object.freeze({
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
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

const canonicalPrompt = (value) => String(value || "")
  .replace(/\r\n?/g, "\n")
  .trim();

const promptPreview = (value) => canonicalPrompt(value)
  .replace(/\s+/gu, " ")
  .slice(0, PROMPT_PREVIEW_MAX_CHARS);

const cleanPromptSource = (value, operationKey = "") => {
  const source = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (/^[a-z0-9][a-z0-9:_-]{0,39}$/u.test(source)) return source;
  return String(operationKey).startsWith("delivery:") ? "bridge" : "api";
};

const promptHashes = (agentId, ...values) => [...new Set(values.flatMap((value) => [
  hashPayload({ agentId, prompt: String(value || "") }),
  hashPayload({ agentId, prompt: canonicalPrompt(value) }),
]))];

const SENSITIVE_TOOL_KEY = /(?:^|[_-])(?:access[_-]?token|api[_-]?key|auth(?:orization)?|cookie|credential|pass(?:word|wd)?|private[_-]?key|secret|session[_-]?token|token)(?:$|[_-])/iu;
const FILE_TOOL = /(?:apply[_-]?patch|edit|file[_-]?change|read|write)/iu;
const COMMAND_TOOL = /(?:bash|command|exec|shell)/iu;
const SEARCH_TOOL = /(?:search|web)/iu;

const redactToolText = (value, maxChars) => {
  let text = String(value ?? "")
    .replace(/\b(?:Bearer\s+)[^\s'";,]+/giu, "Bearer [redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|glpat-[A-Za-z0-9_-]{12,}|npm_[A-Za-z0-9_-]{12,}|pypi-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu, "[redacted]")
    .replace(/\b([A-Za-z0-9_-]*(?:token|secret|password|passwd|api[_-]?key|authorization)[A-Za-z0-9_-]*)\s*([:=])\s*([^\s,;&]+)/giu, "$1$2[redacted]")
    .replace(/data:[^;,\s]+;base64,[A-Za-z0-9+/=]{32,}/giu, "[binary data omitted]")
    .replace(/[A-Za-z0-9+/]{160,}={0,2}/gu, "[binary data omitted]");
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  return text;
};

const parseToolValue = (value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed || !["{", "["].includes(trimmed[0])) return value;
  try { return JSON.parse(trimmed); } catch { return value; }
};

const sanitizeToolValue = (value, depth = 0, seen = new WeakSet()) => {
  const parsed = depth === 0 ? parseToolValue(value) : value;
  if (parsed == null || typeof parsed === "boolean" || typeof parsed === "number") return parsed;
  if (typeof parsed === "string") return redactToolText(parsed, TOOL_RESULT_MAX_CHARS);
  if (typeof parsed !== "object") return String(parsed);
  if (seen.has(parsed)) return "[circular]";
  if (depth >= 3) return "[nested value omitted]";
  seen.add(parsed);
  if (Array.isArray(parsed)) {
    const items = parsed.slice(0, 12).map((item) => sanitizeToolValue(item, depth + 1, seen));
    if (parsed.length > items.length) items.push(`[${parsed.length - items.length} more items]`);
    return items;
  }
  const output = {};
  const entries = Object.entries(parsed).slice(0, 20);
  for (const [key, item] of entries) {
    output[key] = SENSITIVE_TOOL_KEY.test(key)
      ? "[redacted]"
      : sanitizeToolValue(item, depth + 1, seen);
  }
  if (Object.keys(parsed).length > entries.length) output._more = `${Object.keys(parsed).length - entries.length} fields omitted`;
  return output;
};

const compactToolValue = (value, maxChars) => {
  const sanitized = sanitizeToolValue(value);
  const text = typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
  return redactToolText(text, maxChars).trim();
};

const toolPathSummary = (input) => {
  const parsed = parseToolValue(input);
  if (parsed && typeof parsed === "object") {
    const direct = parsed.file_path ?? parsed.filePath ?? parsed.path ?? parsed.paths;
    if (direct) return compactToolValue(direct, TOOL_SUMMARY_MAX_CHARS);
    if (Array.isArray(parsed.changes)) {
      const paths = parsed.changes.map((change) => change?.path ?? change?.filePath).filter(Boolean);
      if (paths.length) return compactToolValue(paths, TOOL_SUMMARY_MAX_CHARS);
    }
  }
  const patch = typeof input === "string" ? input : parsed?.patch;
  if (typeof patch === "string") {
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gmu)].map((match) => match[1]);
    if (paths.length) return compactToolValue(paths, TOOL_SUMMARY_MAX_CHARS);
  }
  return "File operation";
};

const toolSummary = (name, input) => {
  const parsed = parseToolValue(input);
  if (FILE_TOOL.test(name)) return toolPathSummary(parsed);
  if (COMMAND_TOOL.test(name) && parsed && typeof parsed === "object") {
    return compactToolValue(parsed.cmd ?? parsed.command ?? parsed.commandLine ?? parsed, TOOL_SUMMARY_MAX_CHARS);
  }
  if (SEARCH_TOOL.test(name) && parsed && typeof parsed === "object") {
    return compactToolValue(parsed.query ?? parsed.q ?? parsed, TOOL_SUMMARY_MAX_CHARS);
  }
  return compactToolValue(parsed, TOOL_SUMMARY_MAX_CHARS);
};

export function publicToolActivity({
  toolId,
  name,
  phase = "started",
  input,
  result,
  durationMs,
  historical = false,
} = {}) {
  const safeName = redactToolText(String(name || "tool").trim().replace(/\s+/gu, " "), 120) || "tool";
  const safePhase = ["started", "completed", "failed"].includes(phase) ? phase : "failed";
  const summary = input === undefined ? "" : toolSummary(safeName, input);
  const resultPreview = result === undefined ? "" : compactToolValue(result, TOOL_RESULT_MAX_CHARS);
  const rawToolId = String(toolId || "tool");
  const safeToolId = /^[A-Za-z0-9:._-]{1,200}$/u.test(rawToolId)
    ? rawToolId
    : `tool:${hashPayload(rawToolId).slice(0, 32)}`;
  return {
    toolId: safeToolId,
    name: safeName,
    phase: safePhase,
    ...(summary ? { summary } : {}),
    ...(resultPreview ? { result: resultPreview } : {}),
    ...(Number.isFinite(Number(durationMs)) && Number(durationMs) >= 0
      ? { durationMs: Math.round(Number(durationMs)) }
      : {}),
    ...(historical ? { historical: true } : {}),
  };
}

const codexToolDescriptor = (item = {}) => {
  const type = item.type;
  const toolId = item.id ?? item.callId ?? item.call_id;
  if (type === "commandExecution") return {
    toolId,
    name: "exec_command",
    input: { cmd: item.command ?? item.commandLine ?? item.command_line ?? "command" },
    result: item.aggregatedOutput ?? item.output ?? item.stdout ?? item.stderr,
  };
  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths = [item.path ?? item.filePath, ...changes.map((change) => change?.path ?? change?.filePath)].filter(Boolean);
    return {
      toolId,
      name: "apply_patch",
      input: { paths: [...new Set(paths)] },
      result: changes.length ? `${changes.length} file change${changes.length === 1 ? "" : "s"}` : undefined,
    };
  }
  if (type === "webSearch") return {
    toolId,
    name: "web_search",
    input: { query: item.query ?? "" },
  };
  if (type === "mcpToolCall") return {
    toolId,
    name: item.tool ?? item.name ?? "mcp_tool",
    input: item.arguments ?? item.input ?? {},
    result: item.result ?? item.output,
  };
  return null;
};

export function claudePermissionDenial(event) {
  if (event?.type !== "result" || !Array.isArray(event.permission_denials)
      || event.permission_denials.length === 0) return null;
  const details = event.permission_denials.map((denial) => {
    if (typeof denial === "string") return denial;
    return denial?.tool_name || denial?.toolName || denial?.tool
      || denial?.command || denial?.reason || "tool request";
  });
  return {
    count: event.permission_denials.length,
    detail: details.map(String).join(", ").slice(0, 500),
  };
}

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
    || trimmed.startsWith("[AMUX AUTOMATIC QUOTA RECOVERY")
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
 * @param {number} [options.nativeQuotaPollMs]
 * @param {Function} [options.readQuotaSnapshot]
 * @param {Record<string, string | Buffer>} [options.staticAssets]
 * @param {Function} [options.appendEventImpl]
 * WHAT: Routes the native agent registry, runtime, history, and control API.
 * WHY: Keeps engine lifecycle truth behind one durable local boundary.
 */
export function createWebUi(options = {}) {
  const bootId = randomUUID();
  const homeDir = options.homeDir ?? homedir();
  ensureCodexExecutionSafety({ home: join(homeDir, ".codex") });
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
  const appendEventImpl = options.appendEventImpl ?? appendFleetEvent;
  const commands = {
    claude: options.claudeCommand ?? process.env.AMUX_WEB_CLAUDE_COMMAND ?? "claude",
    codex: options.codexCommand ?? process.env.AMUX_WEB_CODEX_COMMAND ?? "codex",
  };
  const autoCompactContextPercent = options.autoCompactContextPercent
    ?? AUTO_COMPACT_CONTEXT_PERCENT;
  const autoCompactIdleMs = options.autoCompactIdleMs ?? AUTO_COMPACT_IDLE_MS;
  const nativeQuotaPollMs = options.nativeQuotaPollMs ?? 30_000;
  const readQuotaSnapshotImpl = options.readQuotaSnapshot ?? readQuotaSnapshot;
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
    sessionImports: new Map(),
    messages: new Map(),
    sideQuestions: new Map(),
    settings: new Map(),
    pins: new Map(),
    compactions: new Map(),
    interrupts: new Map(),
    uploads: new Map(),
  };
  const sideRuns = new Map();
  const sideChildren = new Set();
  const queuedMessages = new Map();
  const codexSessionFiles = new Map();
  let shuttingDown = false;

  const workingDirectoryFor = (agent) => agent.cwd
    ?? projects.get(agent.projectId)?.cwd
    ?? null;

  const queuedMessageCount = (agent) => [...queuedMessages.entries()]
    .filter(([operationKey, entry]) => entry.id === agent.id
      && operationKey !== agent.activeOperationKey).length;

  const rememberReceipt = (map, key, value, limit = Number.POSITIVE_INFINITY) => {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) map.delete(map.keys().next().value);
  };

  const fleetEvent = (agent, event, extra = {}) => {
    if (!agent.address?.session || !Number.isSafeInteger(Number(agent.address.pane))) return;
    try {
      appendEventImpl({
        ts: new Date().toISOString(),
        event,
        session: agent.address.session,
        pane: Number(agent.address.pane),
        cwd: workingDirectoryFor(agent) || "",
        sessionId: agent.sessionId || "",
        ...extra,
        detail: String(extra.detail || "").slice(0, 200),
      });
    } catch (error) {
      console.error(`[native-runtime] event ledger append failed: ${error.message}`);
    }
  };

  const publicAgent = (agent) => {
    if (!agent.context && agent.sessionId) refreshContextFromSession(agent);
    return {
      id: agent.id,
      projectId: agent.projectId,
      name: agent.name,
      backend: "native",
      engine: agent.engine,
      model: agent.model,
      requestedModel: agent.model,
      observedModel: agent.modelObservation?.model ?? null,
      observedEffort: agent.modelObservation?.effort ?? null,
      modelObservation: agent.modelObservation,
      modelGuard: agent.modelGuard,
      effort: agent.effort,
      address: agent.address,
      permissionMode: agent.permissionMode,
      cwd: workingDirectoryFor(agent),
      sessionId: agent.sessionId,
      running: agent.running,
      operation: agent.interruptRequested ? "interrupting" : agent.operation,
      quotaWaiting: [...queuedMessages.values()].some((entry) => entry.id === agent.id && entry.quotaWait),
      context: agent.context,
      idleSince: agent.idleSince,
      autoCompact: {
        contextPercent: autoCompactContextPercent,
        idleMs: autoCompactIdleMs,
        dueAt: agent.autoCompactDueAt,
        armed: agent.autoCompactArmed,
      },
      queuedMessages: queuedMessageCount(agent),
      pinnedAt: agent.pinnedAt,
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

  const promptTurnStatus = (operationKey, receipt) => {
    const agent = agents.get(receipt.id);
    if (queuedMessages.get(operationKey)?.quotaWait) return "quota_waiting";
    if (queuedMessages.has(operationKey) && agent?.activeOperationKey !== operationKey) return "queued";
    if (agent?.running && agent.activeOperationKey === operationKey) return "running";
    if (!receipt.completedAt || receipt.code == null) return "accepted";
    if (receipt.permissionDenied) return "permission_denied";
    if (receipt.interrupted) return "interrupted";
    return Number(receipt.code) === 0 ? "completed" : "failed";
  };

  const publicPromptReceipt = (operationKey, receipt) => {
    const agent = agents.get(receipt.id);
    const projectId = receipt.projectId ?? agent?.projectId ?? null;
    const project = projectId ? projects.get(projectId) : null;
    return {
      operationKey,
      projectId,
      projectName: receipt.projectName ?? project?.name ?? "Deleted project",
      agentId: receipt.id,
      agentName: receipt.agentName ?? agent?.name ?? "Deleted instance",
      acceptedAt: receipt.acceptedAt ?? null,
      completedAt: receipt.completedAt ?? null,
      preview: receipt.promptPreview ?? null,
      previewTruncated: Boolean(receipt.promptPreviewTruncated),
      source: receipt.source ?? cleanPromptSource(null, operationKey),
      deliveryStatus: "accepted",
      turnStatus: promptTurnStatus(operationKey, receipt),
      legacy: !receipt.promptPreview,
    };
  };

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
        modelObservation: agent.modelObservation,
        modelGuard: agent.modelGuard,
        address: agent.address,
        permissionMode: agent.permissionMode,
        cwd: agent.cwd,
        sessionId: agent.sessionId,
        context: agent.context,
        idleSince: agent.idleSince,
        autoCompactArmed: agent.autoCompactArmed,
        pinnedAt: agent.pinnedAt,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
      })),
      receipts: Object.fromEntries(Object.entries(receipts)
        .map(([name, map]) => [name, Object.fromEntries(map)])),
      queuedMessages: Object.fromEntries(queuedMessages),
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
    modelObservation: entry.modelObservation?.model ? entry.modelObservation : null,
    modelGuard: entry.modelGuard?.blocked ? entry.modelGuard : null,
    address: cleanAddress(entry.address) ?? null,
    permissionMode: cleanPermissionMode(entry.permissionMode),
    cwd: typeof entry.cwd === "string" && isAbsolute(entry.cwd) ? resolve(entry.cwd) : null,
    sessionId: entry.sessionId ?? null,
    context: entry.context ?? null,
    createdAt: entry.createdAt ?? now(),
    updatedAt: entry.updatedAt ?? entry.createdAt ?? now(),
    idleSince: entry.idleSince ?? entry.updatedAt ?? entry.createdAt ?? now(),
    pinnedAt: Number.isFinite(entry.pinnedAt) ? entry.pinnedAt : null,
    running: false,
    operation: null,
    activeChild: null,
    activeControl: null,
    activeTurnId: null,
    activeOperationKey: null,
    activeModel: null,
    activeEffort: null,
    activeModelObserved: false,
    interruptRequested: false,
    autoCompactTimer: null,
    autoCompactDueAt: null,
    autoCompactArmed: entry.autoCompactArmed !== false,
    events: [],
    clients: new Set(),
    hydrated: false,
    nextEventId: 1,
    turnHasAssistantText: false,
    turnHadToolActivity: false,
    turnQuotaCandidate: null,
    turnQuotaWait: null,
    permissionDenied: null,
    activeTools: new Map(),
  });

  const loadRegistry = () => {
    if (!existsSync(registryPath)) return false;
    const stored = JSON.parse(readFileSync(registryPath, "utf8"));
    if (stored.schemaVersion !== 1) throw new Error(`unsupported registry schema ${stored.schemaVersion}`);
    const importedAgentIds = new Set(Object.values(stored.receipts?.sessionImports ?? {})
      .map((receipt) => receipt?.id)
      .filter(Boolean));
    for (const entry of stored.projects ?? []) {
      projects.set(entry.id, {
        ...entry,
        communicationPolicy: entry.communicationPolicy ?? defaultCommunicationPolicy(),
      });
    }
    for (const entry of stored.agents ?? []) {
      if (!projects.has(entry.projectId)) throw new Error(`agent ${entry.id} has missing project`);
      if (!commands[entry.engine]) throw new Error(`agent ${entry.id} has unknown engine`);
      agents.set(entry.id, restoreAgent({
        ...entry,
        autoCompactArmed: entry.autoCompactArmed
          ?? !importedAgentIds.has(entry.id),
      }));
    }
    for (const [name, map] of Object.entries(receipts)) {
      for (const [key, value] of Object.entries(stored.receipts?.[name] ?? {})) map.set(key, value);
    }
    for (const [key, value] of Object.entries(stored.queuedMessages ?? {})) {
      if (agents.has(value?.id) && receipts.messages.has(key)) queuedMessages.set(key, value);
    }
    let recoveredUncertainTurns = false;
    for (const [key, entry] of [...queuedMessages.entries()]) {
      if (!entry.startedAt) continue;
      const receipt = receipts.messages.get(key);
      Object.assign(receipt, {
        completedAt: now(),
        code: -1,
        error: "native runtime restarted after submission; delivery outcome is uncertain",
      });
      queuedMessages.delete(key);
      recoveredUncertainTurns = true;
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
    if (upgradedAgentReceipts || recoveredUncertainTurns) saveRegistry();
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
        cwd: entry.cwd,
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
    const cwd = workingDirectoryFor(agent);
    if (!cwd) return null;
    if (agent.engine === "claude") {
      return join(claudeProjectDir(cwd, homeDir), `${agent.sessionId}.jsonl`);
    }
    const base = join(homeDir, ".codex", "sessions");
    if (!existsSync(base)) return null;
    const cached = codexSessionFiles.get(agent.id);
    if (cached?.sessionId === agent.sessionId && existsSync(cached.path)) return cached.path;
    codexSessionFiles.delete(agent.id);
    try {
      const match = readdirSync(base, { recursive: true })
        .find((file) => String(file).endsWith(".jsonl") && String(file).includes(agent.sessionId));
      if (!match) return null;
      const path = join(base, String(match));
      codexSessionFiles.set(agent.id, { sessionId: agent.sessionId, path });
      return path;
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
      const eventHashes = promptHashes(agent.id, text);
      const numericAt = Number(eventAt);
      const parsedAt = typeof eventAt === "string" ? Date.parse(eventAt) : NaN;
      const eventTime = Number.isFinite(numericAt) && numericAt > 0
        ? numericAt
        : Number.isFinite(parsedAt) ? parsedAt : null;
      const unmatched = receiptMatches.filter(({ operationKey }) => !usedReceiptKeys.has(operationKey));
      const distance = ({ receipt }) => Number.isFinite(receipt.acceptedAt) && eventTime != null
        ? Math.abs(receipt.acceptedAt - eventTime)
        : Number.POSITIVE_INFINITY;
      const exact = unmatched
        .filter(({ receipt }) => receipt.promptHashes.some((hash) => eventHashes.includes(hash)))
        .sort((left, right) => distance(left) - distance(right));
      // Engine JSONL can normalize attachment wrappers or message text in a
      // way that does not round-trip through a prompt hash. The runtime owns
      // this session exclusively, so a completed receipt from the same
      // session within a tight timestamp window is a stronger fallback than
      // emitting a second, content-hash turn identity after restart.
      const temporal = eventTime == null ? [] : unmatched
        .filter(({ receipt }) => receipt.sessionId === agent.sessionId
          && receipt.completedAt
          && receipt.hasAssistant
          && distance({ receipt }) <= OPERATION_TIME_MATCH_MS)
        .sort((left, right) => distance(left) - distance(right));
      const match = exact[0] || temporal[0];
      if (!match) return null;
      usedReceiptKeys.add(match.operationKey);
      return match.operationKey;
    };
    let turnOpen = false;
    let turnHasAssistant = false;
    let turnTerminal = false;
    let turnAt = 0;
    let turnOperationKey = null;
    let codexContextTurnId = null;
    const hydratedTools = new Map();
    const eventTime = (value) => {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
      const parsed = typeof value === "string" ? Date.parse(value) : NaN;
      return Number.isFinite(parsed) ? parsed : now();
    };
    const pushHydratedTool = (activity, timestamp) => {
      const at = eventTime(timestamp);
      const toolId = String(activity.toolId || `history:${hashPayload({
        name: activity.name,
        input: activity.input,
        at,
        event: agent.nextEventId,
      }).slice(0, 24)}`);
      const previous = hydratedTools.get(toolId);
      if (activity.phase === "started") {
        hydratedTools.set(toolId, { name: activity.name, input: activity.input, startedAt: at });
      }
      pushEvent(agent, {
        type: "web",
        subtype: "tool",
        ...publicToolActivity({
          ...activity,
          toolId,
          name: activity.name ?? previous?.name,
          input: activity.input ?? previous?.input,
          durationMs: activity.durationMs ?? (previous?.startedAt && activity.phase !== "started"
            ? Math.max(0, at - previous.startedAt)
            : undefined),
          historical: true,
        }),
        at,
        operationKey: turnOperationKey,
      });
      if (activity.phase !== "started") hydratedTools.delete(toolId);
    };
    const closeHydratedTurn = () => {
      const receipt = turnOperationKey ? receipts.messages.get(turnOperationKey) : null;
      const hasReceiptOutcome = receipt?.completedAt && receipt.code != null;
      if (turnOpen && (turnHasAssistant || hasReceiptOutcome)) {
        if (receipt?.permissionDenied) {
          pushEvent(agent, {
            type: "web",
            subtype: "permission-denied",
            message: `The action was stopped by the permission policy: ${receipt.denialDetail || "tool request"}`,
            denial: { detail: receipt.denialDetail || "tool request" },
            historical: true,
            at: receipt.completedAt,
            operationKey: turnOperationKey,
          });
        }
        pushEvent(agent, {
          type: "web",
          subtype: "turn-done",
          code: hasReceiptOutcome ? Number(receipt.code) : 0,
          interrupted: Boolean(receipt?.interrupted),
          permissionDenied: Boolean(receipt?.permissionDenied),
          error: receipt?.error,
          historical: true,
          at: receipt?.completedAt ?? turnAt,
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
          const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
          for (const block of blocks.filter((item) => item?.type === "tool_result")) {
            const previous = hydratedTools.get(String(block.tool_use_id));
            pushHydratedTool({
              toolId: block.tool_use_id,
              name: previous?.name,
              phase: block.is_error ? "failed" : "completed",
              result: block.content,
            }, entry.timestamp);
          }
          const text = textOf(entry.message?.content);
          if (text && !isClaudeHistoryNoise(entry, text) && !isEngineNoise(text)) {
            closeHydratedTurn();
            turnOperationKey = operationKeyForPrompt(text, entry.timestamp);
            pushEvent(agent, {
              type: "web",
              subtype: "user",
              text,
              historical: true,
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
          const textContent = content.filter((block) => block?.type === "text" && typeof block.text === "string");
          const toolBlocks = content.filter((block) => block?.type === "tool_use");
          if (textContent.length) pushEvent(agent, {
            type: "assistant",
            message: { ...entry.message, content: textContent },
            at: entry.timestamp ?? 0,
          });
          for (const block of toolBlocks) pushHydratedTool({
            toolId: block.id,
            name: block.name,
            phase: "started",
            input: block.input,
          }, entry.timestamp);
          turnHasAssistant = turnHasAssistant || Boolean(textOf(textContent)) || toolBlocks.length > 0;
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
      } else if (agent.engine === "codex" && entry.type === "turn_context") {
        codexContextTurnId = String(entry.payload?.turn_id || "").trim() || null;
      } else if (agent.engine === "codex" && entry.type === "response_item") {
        const payload = entry.payload ?? {};
        if (payload.type === "message") {
          const text = textOf(payload.content);
          if (!text || isEngineNoise(text)) continue;
          if (payload.role === "user") {
            const messageTurnId = String(
              payload.internal_chat_message_metadata_passthrough?.turn_id || "",
            ).trim() || null;
            // Codex writes bootstrap/user-role context before the turn_context
            // row. It is not the submitted prompt and must not consume that
            // turn's durable receipt during restart hydration.
            if (messageTurnId && messageTurnId !== codexContextTurnId) continue;
            closeHydratedTurn();
            turnOperationKey = operationKeyForPrompt(text, entry.timestamp);
            pushEvent(agent, {
              type: "web",
              subtype: "user",
              text,
              historical: true,
              at: entry.timestamp ?? 0,
              operationKey: turnOperationKey,
            });
            turnOpen = true;
            turnAt = entry.timestamp ?? 0;
          } else if (payload.role === "assistant") {
            pushEvent(agent, {
              type: "assistant",
              message: { content: [{ type: "text", text }] },
              at: entry.timestamp ?? 0,
            });
            turnHasAssistant = true;
            turnAt = entry.timestamp ?? turnAt;
          }
        } else if (["custom_tool_call", "function_call"].includes(payload.type)) {
          pushHydratedTool({
            toolId: payload.call_id ?? payload.id,
            name: payload.name,
            phase: "started",
            input: payload.input ?? payload.arguments,
          }, entry.timestamp);
          turnHasAssistant = true;
          turnAt = entry.timestamp ?? turnAt;
        } else if (["custom_tool_call_output", "function_call_output"].includes(payload.type)) {
          const previous = hydratedTools.get(String(payload.call_id ?? payload.id));
          pushHydratedTool({
            toolId: payload.call_id ?? payload.id,
            name: previous?.name,
            phase: payload.is_error || payload.error ? "failed" : "completed",
            result: payload.output ?? payload.result ?? payload.error,
          }, entry.timestamp);
          turnAt = entry.timestamp ?? turnAt;
        }
      } else if (agent.engine === "codex" && entry.type === "event_msg"
          && ["task_complete", "turn_aborted"].includes(entry.payload?.type)) {
        turnTerminal = true;
        turnAt = entry.timestamp ?? turnAt;
        closeHydratedTurn();
      }
    }
    const finalReceipt = turnOperationKey ? receipts.messages.get(turnOperationKey) : null;
    if (turnTerminal || (turnOpen && finalReceipt?.completedAt && finalReceipt.code != null)) {
      closeHydratedTurn();
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

  const observeAgentModel = (agent, observation) => {
    if (!observation?.model || agent.operation !== "turn") return null;
    const requestedModel = agent.activeModel ?? agent.model;
    const requestedEffort = agent.activeEffort ?? agent.effort;
    const previous = agent.modelObservation;
    const finding = describeModelObservation({
      previous,
      observation,
      requestedModel,
      requestedEffort,
    });
    if (!finding) return null;
    agent.activeModelObserved = true;

    const sameEvidence = previous?.model === finding.observation.model
      && previous?.effort === finding.observation.effort
      && previous?.requestedModel === finding.observation.requestedModel
      && previous?.requestedEffort === finding.observation.requestedEffort;
    const mustStop = !finding.expected && shouldStopPane(finding.divergence);
    // Repeated evidence is normally noise, but not after an operator has
    // explicitly cleared a model guard for a verification turn. In that case
    // the same fallback is fresh safety evidence and must re-arm the guard.
    if (sameEvidence && (!mustStop || agent.modelGuard?.blocked)) return finding;

    agent.modelObservation = finding.observation;
    let guardChanged = false;
    if (mustStop) {
      const nextGuard = {
        blocked: true,
        since: observation.observedAt ?? now(),
        requestedModel,
        observedModel: observation.model,
        direction: finding.divergence.direction,
        detail: `${finding.divergence.from} → ${finding.divergence.to}`,
      };
      guardChanged = !agent.modelGuard?.blocked
        || agent.modelGuard.requestedModel !== nextGuard.requestedModel
        || agent.modelGuard.observedModel !== nextGuard.observedModel;
      agent.modelGuard = nextGuard;
    } else if (agent.modelGuard) {
      agent.modelGuard = null;
      guardChanged = true;
    }
    agent.updatedAt = now();
    saveRegistry();

    webEvent(agent, "model-observed", {
      observation: agent.modelObservation,
      expected: finding.expected,
      requestedModel,
      requestedEffort,
    });

    // A repeated fallback after an explicit clear is a new safety incident
    // even though the model pair itself did not change. Re-emit that
    // requested-to-observed divergence so the interrupt and audit paths run.
    const actionableChange = finding.change ?? (mustStop && guardChanged ? finding.divergence : null);
    if (actionableChange) {
      const event = {
        direction: actionableChange.direction,
        kind: actionableChange.kind,
        from: actionableChange.from,
        to: actionableChange.to,
        expected: finding.expected,
        cause: finding.cause,
        requestedModel,
        requestedEffort,
        observedModel: observation.model,
        observedEffort: observation.effort,
        source: observation.source,
        reason: observation.reason ?? null,
        policy: mustStop ? "stop" : "allow",
        guardChanged,
      };
      webEvent(agent, "model-change", event);
      fleetEvent(agent, "model_change", {
        direction: event.direction,
        detail: `${event.from} → ${event.to}`,
        source: event.source,
        requestedModel,
        observedModel: observation.model,
        automatic: !finding.expected,
      });
      if (mustStop && guardChanged) {
        fleetEvent(agent, "notification", {
          needsYou: true,
          detail: `model downgrade: ${event.from} → ${event.to}`,
        });
        if (agent.running && !agent.interruptRequested) {
          setImmediate(() => void interruptAgent(agent).catch((error) => {
            webEvent(agent, "model-guard-interrupt-failed", { error: error.message });
          }));
        }
      }
    }
    return finding;
  };

  const refreshModelObservationFromSession = (agent, { deep = false } = {}) => {
    if (agent.engine !== "codex" || !agent.activeTurnId) return null;
    if (agent.modelObservation?.turnId === agent.activeTurnId) return null;
    const path = sessionFileFor(agent);
    if (!path || !existsSync(path)) return null;
    const lines = readTailWindow(path, (deep ? 8 : 1) * 1024 * 1024).text.split("\n");
    const observation = latestCodexModelObservation(lines, now(), { turnId: agent.activeTurnId });
    return observation ? observeAgentModel(agent, observation) : null;
  };

  const emitToolActivity = (agent, activity) => {
    const phase = activity.phase ?? "started";
    const fallbackId = `tool:${hashPayload({
      name: activity.name,
      input: activity.input,
      operationKey: agent.activeOperationKey,
      event: agent.nextEventId,
    }).slice(0, 24)}`;
    const toolId = String(activity.toolId || fallbackId);
    const previous = agent.activeTools.get(toolId);
    const eventAt = now();
    if (phase === "started") {
      agent.activeTools.set(toolId, {
        name: activity.name,
        input: activity.input,
        startedAt: eventAt,
      });
    }
    const durationMs = activity.durationMs ?? (previous?.startedAt && phase !== "started"
      ? Math.max(0, eventAt - previous.startedAt)
      : undefined);
    webEvent(agent, "tool", {
      ...publicToolActivity({
        ...activity,
        toolId,
        name: activity.name ?? previous?.name,
        input: activity.input ?? previous?.input,
        durationMs,
      }),
      operationKey: agent.activeOperationKey,
    });
    if (phase !== "started") agent.activeTools.delete(toolId);
  };

  const publicAttachment = (projectId, attachment) => ({
    name: attachment.name,
    bytes: attachment.bytes,
    image: attachment.image,
    url: `/api/uploads/${projectId}/${encodeURIComponent(basename(attachment.path))}`,
  });

  const recordSessionId = (agent, sessionId) => {
    if (!sessionId || sessionId === agent.sessionId) return;
    agent.sessionId = sessionId;
    agent.updatedAt = now();
    saveRegistry();
    fleetEvent(agent, "session_start", { source: "native-runtime", detail: agent.engine });
    if (agent.running && agent.operation === "turn") {
      fleetEvent(agent, "prompt", { detail: "native turn started" });
    }
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

  const beginOperation = (agent, operation, rawPrompt = "", attachments = [], operationKey = null, settings = null, quotaRetry = false) => {
    const project = projects.get(agent.projectId);
    hydrate(agent);
    clearAutoCompact(agent);
    agent.running = true;
    agent.operation = operation;
    agent.interruptRequested = false;
    agent.activeTurnId = null;
    agent.activeOperationKey = operationKey;
    agent.activeModel = settings?.model ?? agent.model;
    agent.activeEffort = settings?.effort ?? agent.effort;
    agent.activeModelObserved = false;
    agent.turnHasAssistantText = false;
    nativeQuota.resetTurn(agent);
    agent.permissionDenied = null;
    agent.activeTools.clear();
    agent.compactMetadata = null;
    agent.updatedAt = now();
    if (operation === "turn" && !quotaRetry) {
      fleetEvent(agent, "prompt", { detail: rawPrompt });
      webEvent(agent, "user", {
        text: rawPrompt,
        attachments: attachments.map((attachment) => publicAttachment(project.id, attachment)),
        operationKey,
      });
    } else if (operation === "turn") {
      webEvent(agent, "quota-retry", { backend: "native", operationKey });
    } else {
      webEvent(agent, "compact-start", {
        automatic: operation === "auto-compact",
        operationKey,
      });
    }
  };

  const finishOperation = (agent, operation, providedCode, providedError = null, stderr = "") => {
    if (!agent.running || agent.operation !== operation) return;
    let code = providedCode;
    let error = providedError;
    const permissionDenied = agent.permissionDenied;
    if (operation === "turn" && permissionDenied && code === 0) {
      code = 1;
      error = error || new Error(`permission denied: ${permissionDenied.detail}`);
    }
    const operationKey = agent.activeOperationKey;
    const quotaWait = operation === "turn" ? nativeQuota.take(agent, operationKey) : null;
    const control = agent.activeControl;
    const missingModelObservation = operation === "turn"
      && code === 0
      && !agent.interruptRequested
      && !agent.activeModelObserved;
    agent.running = false;
    agent.operation = null;
    agent.activeChild = null;
    agent.activeControl = null;
    agent.activeTurnId = null;
    agent.activeModel = null;
    agent.activeEffort = null;
    agent.activeModelObserved = false;
    agent.activeOperationKey = null;
    nativeQuota.clearTurn(agent);
    agent.permissionDenied = null;
    agent.activeTools.clear();
    agent.updatedAt = now();
    agent.idleSince = agent.updatedAt;
    if (operation === "turn") agent.autoCompactArmed = true;
    agent.events = agent.events.filter((event) => event.type !== "stream_event");
    if (agent.engine === "codex") control?.rpc?.close?.();
    const interrupted = agent.interruptRequested;
    agent.interruptRequested = false;
    if (operation === "turn" && operationKey) {
      const receipt = receipts.messages.get(operationKey);
      if (receipt?.id === agent.id) {
        if (quotaWait) {
          nativeQuota.park(agent, operationKey, receipt, quotaWait);
        } else {
          delete receipt.quotaWait;
          Object.assign(receipt, {
            sessionId: agent.sessionId, completedAt: agent.updatedAt, code, interrupted,
            hasAssistant: Boolean(agent.turnHasAssistantText),
            permissionDenied: Boolean(permissionDenied),
            ...(permissionDenied?.detail ? { denialDetail: permissionDenied.detail } : {}),
            ...(error?.message ? { error: String(error.message).slice(0, 4_000) } : {}),
          });
        }
      }
      if (!quotaWait) queuedMessages.delete(operationKey);
    }
    saveRegistry();
    if (operation === "turn") {
      fleetEvent(agent, "stop", { detail: quotaWait
        ? "native Claude quota wait" : interrupted ? "native turn interrupted" : "native turn finished" });
      if (quotaWait) {
        nativeQuota.wait(agent, operationKey, quotaWait);
        return;
      }
      if (permissionDenied) {
        fleetEvent(agent, "notification", {
          needsYou: true,
          detail: `permission denied: ${permissionDenied.detail}`,
        });
      }
      if (missingModelObservation) {
        webEvent(agent, "model-observation-missing", {
          engine: agent.engine,
          requestedModel: agent.model,
          operationKey,
        });
        fleetEvent(agent, "model_observation_missing", {
          needsYou: true,
          detail: `actual model unavailable after successful ${agent.engine} turn`,
        });
      }
      webEvent(agent, "turn-done", {
        code,
        interrupted,
        permissionDenied: Boolean(permissionDenied),
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
    setImmediate(() => drainQueuedMessages(agent));
  };

  const mapClaudeEvent = (agent, event) => {
    recordSessionId(agent, event.session_id);
    const operation = agent.operation;
    const quota = nativeQuota.observe(agent, event);
    if (quota?.handled) {
      if (quota.endInput) try { agent.activeChild?.stdin?.end?.(); } catch {}
      return;
    }
    const modelObservation = observationFromClaudeEvent(event, now());
    if (modelObservation) observeAgentModel(agent, modelObservation);
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
    if (event.type === "user" && operation === "turn" && !agent.interruptRequested) {
      const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
      for (const block of blocks.filter((item) => item?.type === "tool_result")) {
        nativeQuota.markTool(agent);
        const previous = agent.activeTools.get(String(block.tool_use_id));
        emitToolActivity(agent, {
          toolId: block.tool_use_id,
          name: previous?.name,
          phase: block.is_error ? "failed" : "completed",
          result: block.content,
        });
      }
      return;
    }
    if (event.type === "assistant" && operation === "turn" && !agent.interruptRequested) {
      const content = Array.isArray(event.message?.content) ? event.message.content : [];
      const textContent = content.filter((block) => block?.type === "text" && typeof block.text === "string");
      const toolBlocks = content.filter((block) => block?.type === "tool_use");
      if (toolBlocks.length) nativeQuota.markTool(agent);
      if (textContent.length) {
        agent.turnHasAssistantText = true;
        broadcast(agent, {
          ...event,
          message: { ...event.message, content: textContent },
        });
      }
      for (const block of toolBlocks) emitToolActivity(agent, {
        toolId: block.id,
        name: block.name,
        phase: "started",
        input: block.input,
      });
      return;
    }
    if (event.type !== "result") return;

    if (operation === "turn" && !agent.interruptRequested) {
      const denial = claudePermissionDenial(event);
      if (denial) {
        agent.permissionDenied = denial;
        webEvent(agent, "permission-denied", {
          message: `The action was stopped by the permission policy: ${denial.detail}`,
          denial,
          operationKey: agent.activeOperationKey,
        });
      }
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

  const runClaudeOperation = (agent, rawPrompt, attachments, operation, operationKey = null, quotaRetry = false) => {
    const cwd = workingDirectoryFor(agent);
    const settings = { model: agent.model, effort: agent.effort };
    const launch = buildNativeClaudeLaunch({
      command: commands.claude, agent, rawPrompt, attachments, settings,
    });
    beginOperation(agent, operation, rawPrompt, attachments, operationKey, settings, quotaRetry);
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
        cwd,
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
    const cwd = workingDirectoryFor(agent);
    const settings = { model: agent.model, effort: agent.effort };
    beginOperation(agent, operation, rawPrompt, attachments, operationKey, settings);
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
      } else if (method === "model/rerouted") {
        const observation = observationFromCodexReroute(params, now());
        if (observation) observeAgentModel(agent, observation);
      } else if (method === "thread/tokenUsage/updated" && params.tokenUsage) {
        setAgentContext(agent, contextFromCodexUsage(params.tokenUsage, agent.context));
        refreshModelObservationFromSession(agent);
      } else if (method === "turn/started" && params.turn?.id) {
        agent.activeTurnId = params.turn.id;
        setImmediate(() => refreshModelObservationFromSession(agent));
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
      } else if (["item/started", "item/completed"].includes(method) && operation === "turn"
          && ["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(params.item?.type)) {
        const item = params.item ?? {};
        const tool = codexToolDescriptor(item);
        if (tool) {
          const completed = method === "item/completed";
          const exitCode = Number(item.exitCode ?? item.exit_code);
          const failed = completed && (item.status === "failed" || Boolean(item.error)
            || (Number.isFinite(exitCode) && exitCode !== 0));
          emitToolActivity(agent, {
            ...tool,
            phase: completed ? (failed ? "failed" : "completed") : "started",
            result: failed ? item.error?.message ?? item.error ?? tool.result : tool.result,
            durationMs: item.durationMs ?? item.duration_ms,
          });
        }
      } else if (method === "item/completed" && params.item?.type === "contextCompaction") {
        webEvent(agent, "compacted", { metadata: null });
      } else if (method === "turn/completed") {
        refreshModelObservationFromSession(agent, { deep: true });
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
        cwd,
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
        ? CODEX_AUTONOMOUS_THREAD_POLICY
        : {};
      const turnPolicy = agent.permissionMode === "automation"
        ? CODEX_AUTONOMOUS_TURN_POLICY
        : {};
      const threadResult = agent.sessionId
        ? await rpc.request("thread/resume", {
          threadId: agent.sessionId,
          cwd,
          model: settings.model,
          ...codexPolicy,
        })
        : await rpc.request("thread/start", {
          cwd,
          model: settings.model,
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
          input: buildNativeCodexInput(rawPrompt, attachments),
          cwd,
          model: settings.model,
          effort: settings.effort,
          ...turnPolicy,
        });
        agent.activeTurnId = result?.turn?.id ?? agent.activeTurnId;
      }
    } catch (error) {
      finish(-1, error);
    }
  };

  const runTurn = (agent, rawPrompt, attachments, operationKey = null, quotaRetry = false) => {
    if (agent.engine === "claude") {
      runClaudeOperation(agent, rawPrompt, attachments, "turn", operationKey, quotaRetry);
    } else {
      void runCodexOperation(agent, rawPrompt, attachments, "turn", operationKey);
    }
  };

  const nextQueuedMessage = (agent) => [...queuedMessages.entries()]
    .filter(([, entry]) => entry.id === agent.id)
    .sort(([, left], [, right]) => Number(left.acceptedAt) - Number(right.acceptedAt))[0] ?? null;

  const nativeQuota = createNativeClaudeQuotaController({
    queuedMessages, agents,
    readQuota: async () => (await readQuotaSnapshotImpl()).claude,
    pollMs: nativeQuotaPollMs,
    save: saveRegistry, webEvent, fleetEvent, drain: drainQueuedMessages, now,
    log: (message) => console.error(`[native-runtime] ${message}`),
  });

  function drainQueuedMessages(agent) {
    if (shuttingDown || agent.running || agent.modelGuard?.blocked) return false;
    const next = nextQueuedMessage(agent);
    if (!next) return false;
    const [operationKey, entry] = next;
    if (nativeQuota.blocks(operationKey, entry)) return false;
    // Keep the entry persisted until finishOperation. If the runtime itself
    // dies mid-turn, startup marks the outcome uncertain and refuses an
    // automatic replay; deleting at launch would turn that crash window into
    // silent loss.
    entry.startedAt = now();
    saveRegistry();
    const attempt = nativeQuota.attempt(entry);
    runTurn(agent, attempt.prompt, attempt.attachments, operationKey, attempt.retry);
    return true;
  }

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
    if (!agent.autoCompactArmed || agent.running || !agent.sessionId
        || !Number.isFinite(agent.context?.percent)
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
      "[SIDE QUESTION — do not change or continue the main task]",
      "Answer briefly from the existing conversation context. This is a separate question.",
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
      child = spawnProcess(commands.claude, args, {
        cwd: workingDirectoryFor(agent),
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

    if (request.method === "GET" && pathname === "/api/quota") {
      const forceRefresh = url.searchParams.get("refresh") === "1";
      if (!forceRefresh && quotaCache.payload && now() - quotaCache.at < QUOTA_CACHE_MS) {
        json(response, 200, quotaCache.payload);
        return;
      }
      const snapshot = await readQuotaSnapshotImpl();
      quotaCache = { at: now(), payload: snapshot };
      json(response, 200, snapshot);
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

    if (request.method === "GET" && pathname === "/api/prompts") {
      const scope = url.searchParams.get("scope") || "all";
      const projectId = url.searchParams.get("projectId");
      const agentId = url.searchParams.get("agentId");
      const rawLimit = Number(url.searchParams.get("limit") || PROMPT_JOURNAL_DEFAULT_LIMIT);
      const validId = (value) => new RegExp(`^${UUID_PATTERN}$`, "i").test(String(value || ""));
      if (!new Set(["all", "project", "agent"]).has(scope)) {
        json(response, 400, { error: "unknown-prompt-scope" }); return;
      }
      if ((scope === "project" && !validId(projectId))
          || (scope === "agent" && !validId(agentId))) {
        json(response, 400, { error: "prompt-scope-id-required" }); return;
      }
      if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > PROMPT_JOURNAL_MAX_LIMIT) {
        json(response, 400, { error: "invalid-prompt-limit" }); return;
      }
      const prompts = [...receipts.messages.entries()]
        .filter(([, receipt]) => Number.isFinite(receipt?.acceptedAt))
        .map(([operationKey, receipt]) => publicPromptReceipt(operationKey, receipt))
        .filter((entry) => scope === "all"
          || (scope === "project" && entry.projectId === projectId)
          || (scope === "agent" && entry.agentId === agentId))
        .sort((a, b) => b.acceptedAt - a.acceptedAt)
        .slice(0, rawLimit);
      json(response, 200, { scope, projectId, agentId, prompts });
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

    const projectMatch = pathname.match(new RegExp(`^/api/projects/(${UUID_PATTERN})(/agents|/session-imports|/uploads)?$`, "i"));
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
          cwd: project.cwd,
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

      if (request.method === "POST" && projectMatch[2] === "/session-imports") {
        const body = await readJsonBody(request);
        const key = cleanName(body?.idempotencyKey, 160);
        const name = cleanName(body?.name);
        const engine = body?.engine === "codex" ? "codex" : body?.engine === "claude" ? "claude" : "";
        const model = cleanName(body?.model, 120) || models[engine]?.[0] || "";
        const sessionId = cleanName(body?.sessionId, 80);
        const sourceCwd = expandDirectory(body?.sourceCwd, homeDir);
        const address = cleanAddress(body?.address);
        if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
        if (!name) { json(response, 400, { error: "agent-name-required" }); return; }
        if (!engine) { json(response, 400, { error: "unknown-engine" }); return; }
        if (!address) { json(response, 400, { error: "valid-agent-address-required" }); return; }
        if (body?.permissionMode !== "automation") {
          json(response, 400, { error: "session-import-requires-automation" }); return;
        }
        if (body?.effort !== undefined && !DEFAULT_EFFORTS[engine].includes(body.effort)) {
          json(response, 400, { error: "unknown-effort", allowed: DEFAULT_EFFORTS[engine] }); return;
        }
        const expectedSourceCwd = join(project.cwd, ".agents", String(address.pane));
        if (sourceCwd !== expectedSourceCwd) {
          json(response, 409, { error: "session-source-cwd-mismatch", expectedSourceCwd }); return;
        }
        const identity = persistedSessionIdentity(engine, sessionId, sourceCwd, {
          homeDir,
          sessionDirs: options.codexSessionDirs,
        });
        if (!identity) {
          json(response, 409, { error: "persisted-session-not-found" }); return;
        }
        const effort = cleanEffort(engine, body?.effort);
        const fingerprint = hashPayload({
          projectId: project.id,
          name,
          engine,
          address,
          permissionMode: "automation",
          sessionId,
          sourceCwd,
        });
        const receipt = receiptResult(receipts.sessionImports, key, fingerprint);
        if (receipt?.conflict) { json(response, 409, { error: "idempotency-key-conflict" }); return; }
        if (receipt?.replayed) {
          const agent = agents.get(receipt.id);
          if (agent && !agent.cwd) {
            agent.cwd = sourceCwd;
            agent.autoCompactArmed = false;
            saveRegistry();
          }
          json(response, agent ? 200 : 410, agent
            ? { ...publicAgent(agent), replayed: true }
            : { error: "idempotency-target-deleted" });
          return;
        }
        if ([...agents.values()].some((candidate) => candidate.address?.session === address.session
            && Number(candidate.address?.pane) === Number(address.pane))) {
          json(response, 409, { error: "agent-address-in-use" }); return;
        }
        if ([...agents.values()].some((candidate) => candidate.engine === engine
            && candidate.sessionId === sessionId)) {
          json(response, 409, { error: "persisted-session-in-use" }); return;
        }
        const agent = restoreAgent({
          id: randomUUID(),
          projectId: project.id,
          name,
          engine,
          model,
          effort,
          address,
          permissionMode: "automation",
          cwd: sourceCwd,
          sessionId,
          autoCompactArmed: false,
          createdAt: now(),
          updatedAt: now(),
        });
        agents.set(agent.id, agent);
        project.updatedAt = now();
        rememberReceipt(receipts.sessionImports, key, { id: agent.id, hash: fingerprint });
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

    const agentMatch = pathname.match(new RegExp(`^/api/agents/(${UUID_PATTERN})(/messages|/events|/history|/side-questions|/compact|/interrupt|/pin)?$`, "i"));
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
        const hasAddress = body?.address !== undefined;
        const hasPermissionMode = body?.permissionMode !== undefined;
        if (!hasEffort && !hasModel && !hasAddress && !hasPermissionMode) {
          json(response, 400, { error: "setting-required" }); return;
        }
        if ((hasAddress || hasPermissionMode) && agent.running) {
          json(response, 409, { error: "agent-running" }); return;
        }
        if (hasEffort && !DEFAULT_EFFORTS[agent.engine].includes(body.effort)) {
          json(response, 400, { error: "unknown-effort", allowed: DEFAULT_EFFORTS[agent.engine] }); return;
        }
        const model = hasModel ? cleanName(body.model, 120) : agent.model;
        if (!model) { json(response, 400, { error: "model-required" }); return; }
        const effort = hasEffort ? body.effort : agent.effort;
        const address = hasAddress ? cleanAddress(body.address) : agent.address;
        if (hasAddress && !address) { json(response, 400, { error: "invalid-agent-address" }); return; }
        if (hasAddress && agent.address
            && (agent.address.session !== address.session || Number(agent.address.pane) !== Number(address.pane))) {
          json(response, 409, { error: "agent-address-already-bound" }); return;
        }
        if (hasAddress && [...agents.values()].some((candidate) => candidate.id !== agent.id
            && candidate.address?.session === address.session
            && Number(candidate.address?.pane) === Number(address.pane))) {
          json(response, 409, { error: "agent-address-in-use" }); return;
        }
        if (hasPermissionMode && !["interactive", "automation"].includes(body.permissionMode)) {
          json(response, 400, { error: "invalid-permission-mode" }); return;
        }
        const permissionMode = hasPermissionMode ? body.permissionMode : agent.permissionMode;
        const fingerprint = hasAddress || hasPermissionMode
          ? hashPayload({ agentId: agent.id, effort, model, address, permissionMode })
          : hashPayload({ agentId: agent.id, effort, model });
        const receipt = receiptResult(receipts.settings, key, fingerprint);
        if (receipt?.conflict) { json(response, 409, { error: "idempotency-key-conflict" }); return; }
        if (receipt?.replayed) {
          json(response, 200, { ...publicAgent(agent), replayed: true });
          return;
        }
        const clearedModelGuard = hasModel && Boolean(agent.modelGuard?.blocked);
        agent.effort = effort;
        agent.model = model;
        if (hasModel) agent.modelGuard = null;
        agent.address = address;
        agent.permissionMode = permissionMode;
        agent.updatedAt = now();
        project.updatedAt = agent.updatedAt;
        rememberReceipt(receipts.settings, key, { id: agent.id, hash: fingerprint }, 500);
        saveRegistry();
        webEvent(agent, "settings", {
          effort: agent.effort,
          model: agent.model,
          address: agent.address,
          permissionMode: agent.permissionMode,
          appliesTo: "next-turn",
          clearedModelGuard,
        });
        if (clearedModelGuard && !agent.running) setImmediate(() => drainQueuedMessages(agent));
        json(response, 200, publicAgent(agent));
        return;
      }

      if (request.method === "DELETE" && !agentMatch[2]) {
        if (agent.running) { json(response, 409, { error: "agent-running" }); return; }
        clearAutoCompact(agent);
        for (const client of agent.clients) client.end();
        codexSessionFiles.delete(agent.id);
        agents.delete(agent.id);
        project.updatedAt = now();
        saveRegistry();
        json(response, 200, { deleted: true, sessionPreserved: true });
        return;
      }

      if (request.method === "POST" && agentMatch[2] === "/pin") {
        const body = await readJsonBody(request);
        const key = cleanName(body?.idempotencyKey, 160);
        if (!key) { json(response, 400, { error: "idempotency-key-required" }); return; }
        if (typeof body?.pinned !== "boolean") {
          json(response, 400, { error: "pinned-boolean-required" }); return;
        }
        const fingerprint = hashPayload({ agentId: agent.id, pinned: body.pinned });
        const receipt = receiptResult(receipts.pins, key, fingerprint);
        if (receipt?.conflict) { json(response, 409, { error: "idempotency-key-conflict" }); return; }
        if (receipt?.replayed) {
          json(response, 200, { ...publicAgent(agent), replayed: true });
          return;
        }
        agent.pinnedAt = body.pinned ? now() : null;
        agent.updatedAt = now();
        project.updatedAt = agent.updatedAt;
        rememberReceipt(receipts.pins, key, { id: agent.id, hash: fingerprint }, 1_000);
        saveRegistry();
        json(response, 200, publicAgent(agent));
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
        if (agent.modelGuard?.blocked) {
          json(response, 423, {
            error: "model-downgrade-parked",
            guard: agent.modelGuard,
          });
          return;
        }
        const enginePrompt = agent.engine === "claude"
          ? attachmentPrompt(prompt, attachments)
          : attachmentPrompt(prompt, attachments.filter((attachment) => !attachment.image));
        rememberReceipt(receipts.messages, key, {
          id: agent.id,
          hash: fingerprint,
          promptHashes: promptHashes(agent.id, prompt, enginePrompt),
          projectId: project.id,
          projectName: project.name,
          agentName: agent.name,
          promptPreview: promptPreview(prompt),
          promptPreviewTruncated: canonicalPrompt(prompt).length > PROMPT_PREVIEW_MAX_CHARS,
          source: cleanPromptSource(body?.source, key),
          acceptedAt: now(),
        }, 1_000);
        const queuedForAgent = queuedMessageCount(agent);
        if (queuedForAgent >= MESSAGE_QUEUE_MAX_PER_AGENT) {
          receipts.messages.delete(key);
          json(response, 429, { error: "message-queue-full", limit: MESSAGE_QUEUE_MAX_PER_AGENT });
          return;
        }
        queuedMessages.set(key, { id: agent.id, prompt, attachments, acceptedAt: now() });
        saveRegistry();
        if (agent.running) {
          webEvent(agent, "message-queued", {
            operationKey: key,
            position: queuedForAgent + 1,
            preview: promptPreview(prompt),
          });
          json(response, 202, publicAgent(agent));
          return;
        }
        drainQueuedMessages(agent);
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
        const operations = [...receipts.messages.entries()]
          .filter(([, receipt]) => receipt?.id === agent.id)
          .map(([operationKey, receipt]) => ({
            operationKey,
            acceptedAt: receipt.acceptedAt ?? null,
            completedAt: receipt.completedAt ?? null,
            sessionId: receipt.sessionId ?? null,
            code: receipt.code ?? null,
            interrupted: Boolean(receipt.interrupted),
            permissionDenied: Boolean(receipt.permissionDenied),
            denialDetail: receipt.denialDetail ?? null,
            error: receipt.error ?? null,
          }));
        json(response, 200, {
          bootId,
          agent: publicAgent(agent),
          events: agent.events,
          operations,
        });
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
      for (const agent of agents.values()) {
        if ([...queuedMessages.values()].some((entry) => entry.id === agent.id)) {
          setImmediate(() => drainQueuedMessages(agent));
        }
      }
      resolveListen({
        host,
        port: typeof address === "object" ? address.port : port,
        url: `http://${host}:${typeof address === "object" ? address.port : port}`,
      });
    });
  });

  const close = async () => {
    shuttingDown = true;
    nativeQuota.stop();
    const activeCloses = [];
    for (const agent of agents.values()) {
      clearAutoCompact(agent);
      const child = agent.activeChild;
      if (child && agent.running) {
        activeCloses.push(new Promise((resolveChild) => {
          const timer = setTimeout(resolveChild, 1_000);
          timer.unref?.();
          child.once?.("close", () => { clearTimeout(timer); resolveChild(); });
        }));
      }
      try { child?.kill?.("SIGTERM"); } catch {}
      for (const client of agent.clients) client.end();
      agent.clients.clear();
    }
    for (const child of sideChildren) {
      try { child.kill?.("SIGTERM"); } catch {}
    }
    sideChildren.clear();
    await Promise.allSettled(activeCloses);
    if (!server.listening) return;
    await new Promise((resolveClose) => server.close(() => resolveClose()));
  };

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
