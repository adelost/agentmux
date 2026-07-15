import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { CODEX_APP_SERVER_ARGS } from "../../core/execution-safety.mjs";

const RPC_REQUEST_TIMEOUT_MS = 30_000;

const rpcError = (message) => {
  const detail = message?.error?.message || "codex-app-server-request-failed";
  const error = new Error(detail);
  error.code = message?.error?.code;
  return error;
};

/**
 * Open one private Codex app-server connection for a single active operation.
 * The native thread remains persisted by Codex after this process exits.
 */
export function openCodexRpc({
  spawnProcess,
  command = "codex",
  cwd,
  env,
  onNotification = () => {},
  onStderr = () => {},
  onExit = () => {},
}) {
  const child = spawnProcess(command, [...CODEX_APP_SERVER_ARGS], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let nextRequestId = 1;
  let stopped = false;
  const pending = new Map();

  const rejectPending = (error) => {
    for (const { reject, timeout } of pending.values()) {
      clearTimeout(timeout);
      reject(error);
    }
    pending.clear();
  };

  const write = (message) => {
    if (stopped || !child.stdin?.writable) throw new Error("codex-app-server-not-writable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const notify = (method, params = {}) => write({ method, params });

  const request = (method, params = {}, timeoutMs = RPC_REQUEST_TIMEOUT_MS) => {
    const id = nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex-app-server-timeout:${method}`));
      }, timeoutMs);
      timeout.unref?.();
      pending.set(id, { resolve, reject, timeout });
      try {
        write({ method, id, params });
      } catch (error) {
        clearTimeout(timeout);
        pending.delete(id);
        reject(error);
      }
    });
  };

  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        onNotification({ method: "protocol/error", params: { line: line.slice(0, 4_000) } });
        return;
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timeout);
        if (message.error) entry.reject(rpcError(message));
        else entry.resolve(message.result);
        return;
      }
      if (message.method) onNotification(message);
    });
  }
  child.stderr?.on("data", (chunk) => onStderr(String(chunk)));
  child.once?.("error", (error) => rejectPending(error));
  child.once?.("close", (code) => {
    stopped = true;
    rejectPending(new Error(`codex-app-server-exit-${code ?? "unknown"}`));
    onExit(code);
  });

  const initialize = async () => {
    await request("initialize", {
      clientInfo: {
        name: "agentmux_web_ui",
        title: "AMUX Code",
        version: "0.2.0",
      },
    });
    notify("initialized");
  };

  const close = () => {
    if (stopped) return;
    stopped = true;
    rejectPending(new Error("codex-app-server-closed"));
    try { child.stdin?.end?.(); } catch {}
    try { child.kill?.("SIGTERM"); } catch {}
  };

  return { child, request, notify, initialize, close };
}

export const claudeUserMessage = (content) => ({
  type: "user",
  message: { role: "user", content },
});

export const claudeInterruptRequest = () => ({
  type: "control_request",
  request_id: randomUUID(),
  request: { subtype: "interrupt" },
});

export const writeClaudeMessage = (child, message) => {
  if (!child?.stdin?.writable) throw new Error("claude-stream-not-writable");
  child.stdin.write(`${JSON.stringify(message)}\n`);
};
