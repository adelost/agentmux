// Windows manager core: prompt text, tool bounds, and turn planning for the
// Windows-native manager AI on the _windows_ channel. All decisions live here
// so they are vitest-able; bin/windows-manager.mjs only does Discord I/O,
// bounded process runs, and journaling.

import { spawn } from "node:child_process";
import { classifyRecovery } from "./windows-bridge.mjs";

/** WHAT: Names the manager contract version. WHY: Keeps runbook, tools, and runtime on one explicit contract. */
export const MANAGER_CONTRACT_VERSION = 1;

const LOCAL_STATUS = /^(?:status|hur\s+m[aå]r\s+(?:wsl|bryggan|l[aä]get)|[aä]r\s+(?:wsl|bryggan)\s+(?:uppe|online|nere|offline))\??$/iu;
const LOCAL_LOGS = /^(?:logg(?:ar(?:na)?|en)?|visa\s+logg(?:ar(?:na)?|en)?|vad\s+gick\s+fel)\??$/iu;
const LOCAL_RECOVERY = /(?:\bwsl\b.*(?:\bkra(?:sch|sh)\w*|\b(?:nere|offline|dog|d[oö]d|h[aä]ng\w*|starta|restart\w*|[aå]terst[aä]ll\w*|recover\w*)\b|svarar\s+inte)|\b(?:starta|restart\w*|[aå]terst[aä]ll\w*|recover\w*)\b.*\b(?:wsl|bryggan)\b|^(?:hej[!,.]?\s+)?hur\s+(?:startar|restartar|[aå]terst[aä]ller)\s+vi\??$)/iu;

/** WHAT: Maps a tiny unambiguous rescue vocabulary without an LLM. WHY: Keeps WSL recovery independent from optional provider authentication and availability. */
export function planLocalRescueTurn(userText) {
  const text = String(userText || "").trim().replace(/\s+/gu, " ");
  if (!text) return null;
  if (LOCAL_STATUS.test(text)) return { kind: "status", tools: ["get_status"] };
  if (LOCAL_LOGS.test(text)) return { kind: "logs", tools: ["get_logs"] };
  if (LOCAL_RECOVERY.test(text)) return { kind: "recovery", tools: ["get_status", "recover"] };
  return null;
}

/** WHAT: Formats local rescue results without provider prose. WHY: Keeps measured recovery separate from opaque provider errors. */
export function formatLocalRescueAnswer(plan, toolResults, outcome) {
  const results = Array.isArray(toolResults) ? toolResults : [];
  if (plan?.kind === "status" || plan?.kind === "logs") {
    return String(results.at(-1)?.detail || `AMUX BLOCKED ${plan.kind}-unavailable`);
  }
  const failed = results.filter((result) => result?.ok !== true);
  const finalDetail = String(results.at(-1)?.detail || "recovery-unavailable");
  return [
    `AMUX ${outcome} lokal recovery`,
    `steg=${results.length} fel=${failed.length}`,
    finalDetail,
  ].join("\n");
}

/** WHAT: Formats a provider-independent handoff when general chat fails. WHY: Keeps rescue commands available while the optional manager brain is unavailable. */
export function formatProviderFallback(reason) {
  return [
    `AMUX PARTIAL manager-ai=${String(reason || "unavailable")}`,
    "Rescue fungerar utan AI: skriv status, WSL har kraschat, //recover eller //restart-wsl.",
  ].join("\n");
}

/** WHAT: Defines the allowlisted manager tools with bounds. WHY: Prevents arbitrary model text from becoming an unbounded action. */
export const MANAGER_TOOLS = Object.freeze([
  Object.freeze({
    name: "get_status",
    description: "Läser en färsk observation av WSL och brygg via proben.",
    timeoutMs: 30_000,
    destructive: false,
  }),
  Object.freeze({
    name: "get_logs",
    description: "Hämtar avskalade och hemlighetsrensade loggsvansar.",
    timeoutMs: 30_000,
    destructive: false,
  }),
  Object.freeze({
    name: "start_bridge",
    description: "Startar bryggen inne i WSL när WSL svarar.",
    timeoutMs: 45_000,
    destructive: false,
  }),
  Object.freeze({
    name: "start_wsl",
    description: "Startar WSL under hård timeout, bara när WSL bevisat är offline.",
    timeoutMs: 120_000,
    destructive: false,
  }),
  Object.freeze({
    name: "recover",
    description: "Kör verifieringskedjan efter WSL-retur; degraderad loop utan känt boot-id.",
    timeoutMs: 570_000,
    destructive: false,
  }),
]);

const TOOL_NAMES = new Set(MANAGER_TOOLS.map((tool) => tool.name));
const MAX_TOOL_CALLS_PER_TURN = 3;
const RECOVER_STATUS_FRESH_MS = 60_000;

/** WHAT: Builds the static Swedish manager system prompt. WHY: Keeps safety rules deterministic and independent from model drift. */
export function buildRunbookContext({ contractVersion } = {}) {
  return `Du är Agentmux Windows-hanterare, en Windows-nativ manager-AI på Discord-kanalen _windows_.
Kontraktsversion: ${contractVersion ?? MANAGER_CONTRACT_VERSION}.
Du lever när WSL är död: du körs av node.exe direkt på Windowsvärden och når kanalen utan WSL.
Din uppgift är att observera, klassificera och återställa WSL- och bryggfel inom hårda gränser.
Deterministiska //kommandon ägs av restarter-pollern och är aldrig dina.

FELKLASSER
1. WSL OOM/hang/omstart: WSL svarar inte eller har startat om. Bryggen kan vara felfri men oåtkomlig.
2. Bara bryggen nere: WSL svarar men bryggens heartbeat saknas eller är gammal.
3. Värden död: Windowsvärden svarar inte. Då är du också tyst och inget verktyg hjälper.

VERKTYG (max 3 anrop per tur, exakt ett JSON-objekt per rad)
{"tool":"get_status"} 30s: läser en färsk observation via proben.
{"tool":"get_logs"} 30s: hämtar avskalade loggsvansar.
{"tool":"start_bridge"} 45s: startar bryggen när WSL svarar.
{"tool":"start_wsl"} 120s: startar WSL, endast när WSL bevisat är offline.
{"tool":"recover"} 570s: kör verifieringskedjan efter WSL-retur, degraderad loop utan känt boot-id.

SÄKERHETSREGLER
Begär alltid en färsk observation med get_status innan någon åtgärd.
Kör aldrig wsl --shutdown vid ett rent timeout. Ett tyst svar bevisar inte att WSL är skadat.
Destruktiv omstart kräver ett uttryckligt och färskt mänskligt kommando plus en färsk
restart-ready-kvittens med matchande fleet generation. Det äger restarter-pollern, aldrig du.
start_wsl är tillåtet endast när observationen visar wsl=offline. Vid wsl=unknown läser du status igen.
recover kräver en statusläsning som är yngre än 60 sekunder.
Efter WSL-retur verifierar recover ny boot-identitet och release-identitet före revive;
utan ett lagrat boot-id före omstarten är utfallet degraderat PARTIAL.
Journalföring sker före varje exekvering; en krasch ger BLOCKED vid nästa start, aldrig en tyst omkörning.
Rapportera exakt RECOVERED, PARTIAL eller BLOCKED. RECOVERED betyder att varje steg lyckades.
Ge aldrig ett falskt ACK. Om ett verktyg nekades eller misslyckades, säg det med exakt orsak.
Klassificera autentiseringsfel (401/403, ogiltig token, saknad miljövariabel) utan att lova en fix;
återställning av autentisering kräver en människa.
Svara kort, sakligt och på svenska. Hemligheter ska aldrig upprepas.`;
}

/** WHAT: Builds the provider message array for one turn. WHY: Separates prompt assembly from provider transport and bounds history. */
export function planManagerTurn({
  userText,
  observation = null,
  history = [],
  contractVersion,
  maxHistory = 10,
} = {}) {
  const runbook = buildRunbookContext({ contractVersion });
  const observationJson = observation === null || observation === undefined
    ? "null"
    : redactSecrets(JSON.stringify(observation));
  const system = `${runbook}\n\nAktuell observation (JSON):\n${observationJson}`;
  return [
    { role: "system", content: system },
    ...history.slice(-maxHistory),
    { role: "user", content: String(userText ?? "") },
  ];
}

/** WHAT: Parses strict per-line tool requests from model text. WHY: Prevents prose from executing tools and caps each turn. */
export function parseToolCalls(text) {
  const calls = [];
  for (const line of String(text || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (typeof parsed.tool !== "string" || !TOOL_NAMES.has(parsed.tool)) continue;
    calls.push(parsed.tool);
    if (calls.length >= MAX_TOOL_CALLS_PER_TURN) break;
  }
  return calls;
}

/** WHAT: Checks one tool request against freshness bounds. WHY: Prevents actions without a fresh proven observation. */
export function planToolCall({ name, observation = null, lastStatusMs = null, nowMs = Date.now() } = {}) {
  if (!TOOL_NAMES.has(name)) return { allow: false, reason: "unknown-tool" };
  if (name === "start_wsl") {
    if (observation?.wsl !== "offline") return { allow: false, reason: "wsl-not-proven-offline" };
    return { allow: true, reason: "ok" };
  }
  if (name === "recover") {
    const fresh = Number.isFinite(lastStatusMs)
      && Number.isFinite(nowMs)
      && nowMs >= lastStatusMs
      && nowMs - lastStatusMs <= RECOVER_STATUS_FRESH_MS;
    if (!fresh) return { allow: false, reason: "status-stale" };
    return { allow: true, reason: "ok" };
  }
  return { allow: true, reason: "ok" };
}

/** WHAT: Tracks the latest and previous WSL boot ids in manager state. WHY: Keeps the pre-boot identity available for the exact recovery chain. */
export function trackManagerBootId(state, observation = null) {
  const bootId = typeof observation?.bootId === "string" && observation.bootId ? observation.bootId : null;
  if (!state || !bootId || bootId === state.lastBootId) return state;
  state.prevBootId = state.lastBootId || state.prevBootId || null;
  state.lastBootId = bootId;
  return state;
}

/** WHAT: Routes one manager tool to its rescue command and arguments. WHY: Separates recover-verify selection from bounded process execution. */
export function planRescueCommand({ name, beforeBootId = null } = {}) {
  if (name !== "recover") return { command: String(name).replaceAll("_", "-"), beforeBootId: null, degraded: false };
  const bootId = typeof beforeBootId === "string" && /^[0-9a-fA-F-]{8,64}$/u.test(beforeBootId) ? beforeBootId : null;
  if (bootId) return { command: "recover-verify", beforeBootId: bootId, degraded: false };
  return { command: "recover", beforeBootId: null, degraded: true };
}

/** WHAT: Maps tool results to one recovery outcome. WHY: Keeps RECOVERED, PARTIAL, and BLOCKED honest through the bridge classifier. */
export function classifyManagerOutcome(toolResults = []) {
  return classifyRecovery(toolResults);
}

/** WHAT: Filters Discord tokens and API keys out of text. WHY: Prevents secrets from reaching prompts, logs, or Discord. */
export function redactSecrets(text) {
  return String(text ?? "")
    .replace(/mfa[\w-]{20,}/gu, "***")
    .replace(/[\w-]{24}\.[\w-]{6}\.[\w-]{27,}/gu, "***")
    .replace(/sk-[\w-]{20,}/gu, "***")
    .replace(/key-[\w-]{20,}/gu, "***");
}

/** WHAT: Stubs a scripted chat provider for tests. WHY: Keeps manager flow tests deterministic without any network. */
export function createMockProvider(responses = []) {
  const queue = [...responses];
  return {
    name: "mock",
    chat: async () => {
      if (!queue.length) return { ok: false, reason: "mock-exhausted" };
      const next = queue.shift();
      if (typeof next === "string") return { ok: true, text: next };
      return next;
    },
  };
}

/** WHAT: Wraps an OpenAI-compatible chat endpoint as a provider. WHY: Separates HTTP transport and secrets from manager logic. */
export function createHttpProvider({
  endpoint,
  model,
  apiKeyProvider,
  timeoutMs = 45_000,
  fetchImpl = fetch,
} = {}) {
  return {
    name: "http",
    chat: async (messages) => {
      let response;
      try {
        response = await fetchImpl(`${endpoint}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKeyProvider()}`,
          },
          body: JSON.stringify({ model, messages }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        return { ok: false, reason: timedOut ? "timeout" : "request-failed" };
      }
      if (!response.ok) return { ok: false, reason: `http-${response.status}` };
      let data;
      try {
        data = await response.json();
      } catch {
        return { ok: false, reason: "bad-json" };
      }
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "empty-response" };
      return { ok: true, text };
    },
  };
}

/** WHAT: Builds the configured manager provider. WHY: Keeps provider selection out of the poll loop. */
export function createManagerProvider(config) {
  const spec = config.provider || {};
  if (spec.kind === "mock") return createMockProvider(spec.responses || []);
  if (spec.kind === "cli") {
    return createCliProvider({
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args : [],
      timeoutMs: Number(spec.timeoutMs) || 120_000,
    });
  }
  const apiKeyEnv = spec.apiKeyEnv || "MANAGER_API_KEY";
  return createHttpProvider({
    endpoint: spec.endpoint,
    model: spec.model,
    apiKeyProvider: () => process.env[apiKeyEnv] || "",
  });
}

/** WHAT: Extracts the answer body from a codex exec transcript. WHY: Separates engine chrome from the reply text. */
export function extractCliAnswer(stdout) {
  const body = [];
  for (const line of String(stdout || "").split("\n")) {
    if (/^tokens used\s*$/u.test(line.trim())) break;
    body.push(line);
  }
  if (body.length && body[0].trim() === "codex") body.shift();
  const text = body.join("\n").trim();
  return text || null;
}

/** WHAT: Builds a CLI-backed chat provider such as codex exec. WHY: Keeps the engine replaceable and secrets inside the CLI session. */
export function createCliProvider({
  command,
  args = [],
  timeoutMs = 120_000,
  execImpl = null,
} = {}) {
  const defaultExec = (cmd, cmdArgs, input, timeout) => new Promise((resolvePromise) => {
    const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolvePromise(result);
      }
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, timedOut: true });
    }, timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: -1, stdout, stderr: String(error?.message || error), timedOut: false }));
    child.on("close", (code) => finish({ code, stdout, stderr, timedOut: false }));
    child.stdin.end(input);
  });
  return {
    name: "cli",
    chat: async (messages) => {
      const prompt = (messages || []).map((message) => {
        const role = message.role === "system" ? "SYSTEM" : (message.role === "assistant" ? "ASSISTANT" : "USER");
        return `[${role}]\n${typeof message.content === "string" ? message.content : ""}`;
      }).join("\n\n");
      if (!command || !prompt.trim()) return { ok: false, reason: "usage" };
      const run = execImpl || defaultExec;
      const result = await run(command, args, prompt, timeoutMs);
      if (result.timedOut) return { ok: false, reason: "timeout" };
      if (result.code !== 0) return { ok: false, reason: `exit-${result.code}` };
      const text = extractCliAnswer(result.stdout);
      if (!text) return { ok: false, reason: "empty-response" };
      return { ok: true, text };
    },
  };
}
