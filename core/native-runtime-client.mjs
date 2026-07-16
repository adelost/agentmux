// Compatibility adapter between agentmux's durable delivery queue and the
// browser-native runtime. A configured target is either native or tmux; the
// adapter never falls back implicitly because two live engines for one pane
// would be worse than a visible, retryable outage.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { loadConfig } from "../cli/config.mjs";

const DEFAULT_RUNTIME_URL = "http://127.0.0.1:8811";
const ATTACHMENT_PATTERN = /\[(image|file) attached:\s+([^\]\n]+)\]/gi;
const NATIVE_COMMAND = /^native:(claude|codex)$/i;

export class NativeRuntimeError extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = "NativeRuntimeError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const normalizeUrl = (value) => String(value || DEFAULT_RUNTIME_URL).replace(/\/+$/, "");
const keyHash = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 24);

export const nativeProjectKey = (name, entry) =>
  `amux-project:${entry?.id || keyHash(`${name}:${entry?.dir || ""}`)}`;

export const nativeAgentKey = (name, entry, pane) =>
  `amux-agent:${entry?.id || keyHash(`${name}:${entry?.dir || ""}`)}:${Number(pane)}`;

function paneEngine(pane) {
  if (["claude", "codex"].includes(pane?.engine)) return pane.engine;
  const match = String(pane?.cmd || "").match(NATIVE_COMMAND);
  return match?.[1]?.toLowerCase() ?? null;
}

function contextShape(context) {
  if (!context || !Number.isFinite(context.percent)) return null;
  return {
    percent: Math.round(context.percent),
    tokens: Number.isFinite(context.usedTokens) ? context.usedTokens : null,
    model: context.model ?? null,
    effort: context.effort ?? null,
    source: "native-runtime",
  };
}

function responseSegments(events = []) {
  let current = [];
  let latest = [];
  for (const event of events) {
    if (event?.type === "web" && event.subtype === "user") current = [];
    if (event?.type === "assistant") {
      const text = (Array.isArray(event.message?.content) ? event.message.content : [])
        .filter((item) => typeof item?.text === "string"
          && ["text", "input_text", "output_text"].includes(item.type))
        .map((item) => item.text.trim())
        .filter(Boolean);
      current.push(...text);
    }
    if (event?.type === "web" && event.subtype === "turn-done") latest = [...current];
  }
  return current.length ? current : latest;
}

/**
 * @param {object} [options]
 * @param {string} [options.configPath]
 * @param {Function} [options.fetchImpl]
 * @param {Function} [options.loadConfigImpl]
 * @param {number} [options.timeoutMs]
 */
export function createNativeRuntimeClient({
  configPath,
  fetchImpl = globalThis.fetch,
  loadConfigImpl = loadConfig,
  timeoutMs = 10_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("native runtime requires fetch");
  const targetCache = new Map();

  const config = () => loadConfigImpl(configPath);

  function target(name, pane, { strict = false } = {}) {
    const entry = config()?.[name];
    if (entry?.backend !== "native") return null;
    const index = Number(pane);
    const paneConfig = entry.panes?.[index];
    const engine = paneEngine(paneConfig);
    if (!entry.dir || !Number.isSafeInteger(index) || index < 0 || !paneConfig || !engine) {
      if (strict) {
        throw new NativeRuntimeError(`invalid native target ${name}:${pane}`, {
          code: "invalid-native-target",
        });
      }
      return null;
    }
    return {
      name,
      pane: index,
      entry,
      paneConfig,
      engine,
      runtimeUrl: normalizeUrl(entry.runtimeUrl || process.env.AMUX_WEB_RUNTIME_URL),
    };
  }

  function isNativeTarget(name, pane = 0) {
    return Boolean(target(name, pane));
  }

  async function api(runtimeUrl, path, { method = "GET", body, headers = {}, timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();
    let response;
    try {
      response = await fetchImpl(`${runtimeUrl}${path}`, {
        method,
        headers: body === undefined
          ? headers
          : { "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const detail = error?.name === "AbortError" ? "timed out" : error.message;
      throw new NativeRuntimeError(`native runtime unavailable: ${detail}`, {
        code: "native-runtime-unavailable",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const code = payload?.error || `http-${response.status}`;
      throw new NativeRuntimeError(`native runtime ${code}`, {
        status: response.status,
        code,
        retryable: response.status >= 500
          || [
            "turn-in-progress",
            "interrupt-not-ready",
            "agent-not-running",
            "compact-needs-session",
          ].includes(code),
      });
    }
    return payload;
  }

  async function ensureTarget(name, pane = 0) {
    const spec = target(name, pane, { strict: true });
    if (!spec) throw new NativeRuntimeError(`${name}:${pane} is not native`, { code: "not-native" });
    const cacheKey = `${name}:${pane}`;
    const cached = targetCache.get(cacheKey);
    if (cached?.runtimeUrl === spec.runtimeUrl) return cached;

    await api(spec.runtimeUrl, "/api/health");
    const adoptedId = String(spec.paneConfig.nativeAgentId || "").trim();
    let project;
    let agent;
    if (adoptedId) {
      const listing = await api(spec.runtimeUrl, "/api/projects");
      const matches = (listing?.projects || []).flatMap((candidateProject) =>
        (candidateProject.agents || [])
          .filter((candidateAgent) => candidateAgent.id === adoptedId)
          .map((candidateAgent) => ({ project: candidateProject, agent: candidateAgent })));
      if (matches.length !== 1) {
        throw new NativeRuntimeError(`native adopted agent ${adoptedId} not found exactly once`, {
          code: "native-adopted-agent-not-found",
        });
      }
      ({ project, agent } = matches[0]);
      if (project.cwd !== spec.entry.dir || agent.engine !== spec.engine || !agent.sessionId) {
        throw new NativeRuntimeError(`native adopted agent ${adoptedId} does not match target continuity`, {
          code: "native-adopted-agent-mismatch",
        });
      }
      const expectedAddress = { session: name, pane: Number(pane) };
      if (agent.address && (agent.address.session !== expectedAddress.session
          || Number(agent.address.pane) !== expectedAddress.pane)) {
        throw new NativeRuntimeError(`native adopted agent ${adoptedId} already has another address`, {
          code: "native-adopted-agent-address-conflict",
        });
      }
    } else {
      const projectKey = nativeProjectKey(name, spec.entry);
      project = await api(spec.runtimeUrl, "/api/projects", {
        method: "POST",
        body: {
          idempotencyKey: projectKey,
          name: `AMUX · ${name}`,
          cwd: spec.entry.dir,
        },
      });
      const agentKey = nativeAgentKey(name, spec.entry, pane);
      agent = await api(spec.runtimeUrl, `/api/projects/${project.id}/agents`, {
        method: "POST",
        body: {
          idempotencyKey: agentKey,
          name: `${name}:${pane}`,
          engine: spec.engine,
          address: { session: name, pane: Number(pane) },
          permissionMode: "automation",
        },
      });
    }
    const settings = {
      ...(adoptedId && !agent.address
        ? { address: { session: name, pane: Number(pane) } } : {}),
      ...(adoptedId && agent.permissionMode !== "automation"
        ? { permissionMode: "automation" } : {}),
      ...(spec.paneConfig.model && spec.paneConfig.model !== agent.model
        ? { model: spec.paneConfig.model } : {}),
      ...(spec.paneConfig.effort && spec.paneConfig.effort !== agent.effort
        ? { effort: spec.paneConfig.effort } : {}),
    };
    if (Object.keys(settings).length) {
      const transitionKey = keyHash(JSON.stringify({
        agentId: agent.id,
        from: { model: agent.model, effort: agent.effort, updatedAt: agent.updatedAt },
        to: settings,
      }));
      agent = await api(spec.runtimeUrl, `/api/agents/${agent.id}`, {
        method: "PATCH",
        body: {
          ...settings,
          idempotencyKey: `amux-config-settings:${transitionKey}`,
        },
      });
    }
    const resolved = { ...spec, project, agent };
    targetCache.set(cacheKey, resolved);
    return resolved;
  }

  async function ensureSession(name) {
    const entry = config()?.[name];
    if (entry?.backend !== "native" || !Array.isArray(entry.panes)) {
      throw new NativeRuntimeError(`${name} is not a native session`, { code: "not-native" });
    }
    return Promise.all(entry.panes.map((_, pane) => ensureTarget(name, pane)));
  }

  async function uploadAttachment(resolved, path, name, key) {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetchImpl(
        `${resolved.runtimeUrl}/api/projects/${resolved.project.id}/uploads?name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-idempotency-key": key,
          },
          body: readFileSync(path),
          signal: controller.signal,
        },
      );
      let payload = null;
      try { payload = await response.json(); } catch {}
      if (!response.ok) {
        // An unsupported file remains an explicit local path in the prompt;
        // the engine and the user lose nothing merely because the web viewer
        // cannot persist that extension as an attachment.
        if (response.status === 400 && payload?.error === "extension-not-allowed") return null;
        throw new NativeRuntimeError(`native runtime ${payload?.error || `http-${response.status}`}`, {
          status: response.status,
          code: payload?.error,
          retryable: response.status >= 500,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof NativeRuntimeError) throw error;
      const detail = error?.name === "AbortError" ? "timed out" : error.message;
      throw new NativeRuntimeError(`native upload unavailable: ${detail}`, {
        code: "native-runtime-unavailable",
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function prepareMessage(resolved, job) {
    let prompt = String(job.text || "");
    const attachments = [];
    const matches = [...prompt.matchAll(ATTACHMENT_PATTERN)];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const originalPath = match[2].trim();
      const durable = (job.assets || []).find((item) => item.original === originalPath);
      const path = existsSync(originalPath) ? originalPath : durable?.backup;
      if (!path) continue;
      const name = basename(originalPath) || `attachment${extname(path)}`;
      const uploaded = await uploadAttachment(
        resolved,
        path,
        name,
        `delivery-upload:${job.id}:${index}`,
      );
      if (!uploaded) continue;
      attachments.push({ path: uploaded.path, name: uploaded.name });
      prompt = prompt.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim();
    }
    return { prompt: prompt || "Se bifogad fil.", attachments };
  }

  async function withReprovisionedTarget(name, pane, operation) {
    let resolved = await ensureTarget(name, pane);
    try {
      return await operation(resolved);
    } catch (error) {
      if (!(error instanceof NativeRuntimeError) || error.status !== 404) throw error;
      // A runtime restart or registry replacement can invalidate an agent id
      // cached by the long-lived bridge. A 404 is a conclusive non-acceptance,
      // so reprovisioning and retrying the same idempotency key is safe.
      targetCache.delete(`${name}:${Number(pane)}`);
      resolved = await ensureTarget(name, pane);
      return operation(resolved);
    }
  }

  async function deliverQueued(job) {
    const trimmed = String(job.text || "").trim();
    const key = `delivery:${job.id}`;
    try {
      return await withReprovisionedTarget(job.agentName, job.pane, async (resolved) => {
        if (job.kind === "slash" && /^\/compact(?:\s|$)/i.test(trimmed)) {
          const agent = await api(resolved.runtimeUrl, `/api/agents/${resolved.agent.id}/compact`, {
            method: "POST",
            body: {
              idempotencyKey: key,
              focus: trimmed.replace(/^\/compact\s*/i, "").trim() || undefined,
            },
          });
          return { accepted: true, replayed: Boolean(agent.replayed), via: "native-compact" };
        }
        if (job.kind === "slash" && /^\/interrupt(?:\s|$)/i.test(trimmed)) {
          const agent = await api(resolved.runtimeUrl, `/api/agents/${resolved.agent.id}/interrupt`, {
            method: "POST",
            body: { idempotencyKey: key },
          });
          return { accepted: true, replayed: Boolean(agent.replayed), via: "native-interrupt" };
        }
        const modelSpec = trimmed.match(/^\/model\s+([^\s]+)(?:\s+(low|medium|high|xhigh|max))?$/i);
        const model = modelSpec?.[1]?.trim();
        const modelEffort = modelSpec?.[2]?.toLowerCase();
        const effort = trimmed.match(/^\/effort\s+(\w+)$/i)?.[1]?.trim();
        if (job.kind === "slash" && (model || modelEffort || effort)) {
          const agent = await api(resolved.runtimeUrl, `/api/agents/${resolved.agent.id}`, {
            method: "PATCH",
            body: {
              idempotencyKey: key,
              ...(model ? { model } : {}),
              ...(modelEffort || effort ? { effort: modelEffort || effort } : {}),
            },
          });
          return { accepted: true, replayed: Boolean(agent.replayed), via: "native-settings" };
        }

        const message = await prepareMessage(resolved, job);
        const agent = await api(resolved.runtimeUrl, `/api/agents/${resolved.agent.id}/messages`, {
          method: "POST",
          body: {
            ...message,
            idempotencyKey: key,
            source: String(job.source || "bridge").slice(0, 40),
          },
        });
        return {
          accepted: true,
          replayed: Boolean(agent.replayed),
          completionPending: true,
          operationKey: key,
          via: "native-message",
        };
      });
    } catch (error) {
      if (error instanceof NativeRuntimeError && error.retryable) {
        return { accepted: false, retryable: true, reason: error.message, code: error.code };
      }
      throw error;
    }
  }

  async function deliveryStatus(job) {
    const operationKey = `delivery:${job.id}`;
    const snapshot = await history(job.agentName, job.pane);
    const durable = (snapshot.operations || [])
      .find((operation) => operation.operationKey === operationKey);
    const terminal = snapshot.events.find((event) => event?.type === "web"
      && event.subtype === "turn-done" && event.operationKey === operationKey);
    const outcome = durable || terminal;
    if (outcome && outcome.code != null) {
      if (outcome.interrupted) {
        return { state: "interrupted", operationKey, code: Number(outcome.code) };
      }
      return Number(outcome.code) === 0
        ? { state: "completed", operationKey, code: 0 }
        : {
          state: "failed",
          operationKey,
          code: Number(outcome.code),
          reason: outcome.error || outcome.stderr || `native turn failed (${outcome.code})`,
        };
    }
    const accepted = snapshot.events.some((event) => event?.type === "web"
      && event.subtype === "user" && event.operationKey === operationKey);
    return {
      state: accepted || durable ? "running" : "unknown",
      operationKey,
    };
  }

  async function history(name, pane = 0) {
    let resolved = await ensureTarget(name, pane);
    try {
      return await api(resolved.runtimeUrl, `/api/agents/${resolved.agent.id}/history`);
    } catch (error) {
      if (error.status !== 404) throw error;
      targetCache.delete(`${name}:${Number(pane)}`);
      resolved = await ensureTarget(name, pane);
      return api(resolved.runtimeUrl, `/api/agents/${resolved.agent.id}/history`);
    }
  }

  async function getContext(name, pane = 0) {
    const snapshot = await history(name, pane);
    const context = contextShape({
      ...snapshot.agent.context,
      model: snapshot.agent.model,
      effort: snapshot.agent.effort,
    });
    return context;
  }

  async function getResponseSegments(name, pane = 0) {
    return responseSegments((await history(name, pane)).events);
  }

  async function getResponse(name, pane = 0) {
    return (await getResponseSegments(name, pane)).join("\n\n").trim();
  }

  async function getResponseStreamWithRaw(name, pane = 0) {
    const segments = await getResponseSegments(name, pane);
    const text = segments.join("\n\n").trim();
    return {
      raw: text,
      turn: text,
      items: segments.map((content) => ({ type: "text", content })),
      source: "native-runtime",
    };
  }

  async function paneHistorySize(name, pane = 0) {
    return (await history(name, pane)).events.length;
  }

  async function updateSettings(name, pane = 0, settings = {}) {
    const resolved = await ensureTarget(name, pane);
    const body = {};
    if (settings.model) body.model = settings.model;
    if (settings.effort) body.effort = settings.effort;
    if (!body.model && !body.effort) return resolved.agent;
    return api(resolved.runtimeUrl, `/api/agents/${resolved.agent.id}`, {
      method: "PATCH",
      body: {
        ...body,
        idempotencyKey: settings.idempotencyKey || `manual-settings:${randomUUID()}`,
      },
    });
  }

  function startProgressTimer(send, name, pane = 0, { streaming = true, intervalMs = 3_000 } = {}) {
    let sent = 0;
    let polling = false;
    const timer = setInterval(async () => {
      if (!streaming || polling) return;
      polling = true;
      try {
        const segments = await getResponseSegments(name, pane);
        if (segments.length > 1 && sent < segments.length - 1) {
          const batch = segments.slice(sent, -1);
          sent = segments.length - 1;
          if (batch.length) await send(batch.join("\n\n"));
        }
      } catch {
        // The command's outer idle poll owns user-visible error handling.
      } finally {
        polling = false;
      }
    }, intervalMs);
    timer.unref?.();
    return { timer, sentCount: () => sent };
  }

  async function isBusy(name, pane = 0) {
    return Boolean((await history(name, pane)).agent.running);
  }

  async function sendEscape(name, pane = 0) {
    const resolved = await ensureTarget(name, pane);
    return api(resolved.runtimeUrl, `/api/agents/${resolved.agent.id}/interrupt`, {
      method: "POST",
      body: { idempotencyKey: `manual-interrupt:${randomUUID()}` },
    });
  }

  async function capturePane(name, pane = 0) {
    const snapshot = await history(name, pane);
    const latest = [...snapshot.events].reverse()
      .find((event) => event.type === "assistant" || event.subtype === "turn-done");
    const text = latest?.message?.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n") || "";
    const state = snapshot.agent.running ? "Working" : "Ready";
    const context = snapshot.agent.context?.percent;
    return [text, state, Number.isFinite(context) ? `Context ${Math.round(context)}%` : ""]
      .filter(Boolean)
      .join("\n");
  }

  async function health(runtimeUrl = null) {
    return api(normalizeUrl(runtimeUrl || process.env.AMUX_WEB_RUNTIME_URL), "/api/health");
  }

  return {
    isNativeTarget,
    ensureTarget,
    ensureSession,
    deliverQueued,
    deliveryStatus,
    history,
    getContext,
    getResponse,
    getResponseSegments,
    getResponseStreamWithRaw,
    paneHistorySize,
    updateSettings,
    startProgressTimer,
    isBusy,
    sendEscape,
    capturePane,
    health,
  };
}
