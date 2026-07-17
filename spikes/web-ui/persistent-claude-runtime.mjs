import { createInterface } from "node:readline";

/**
 * WHAT: Owns one long-lived Claude stream-json child for an agent.
 * WHY: A turn boundary must not become a process boundary and rebuild session state.
 */
export function openPersistentClaudeRuntime({
  spawnProcess,
  command,
  args,
  cwd,
  env,
  signature,
  onEvent = () => {},
  onProtocolError = () => {},
  onStderr = () => {},
  onExit = () => {},
}) {
  const child = spawnProcess(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let expectedStop = false;
  let settled = false;
  let killTimer = null;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });

  const settle = (code, error = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(killTimer);
    resolveClosed({ code, error, expected: expectedStop });
    onExit({ code, error, expected: expectedStop });
  };

  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try {
        onEvent(JSON.parse(line));
      } catch (error) {
        onProtocolError({ line: line.slice(0, 4_000), error });
      }
    });
  }
  child.stderr?.on("data", (chunk) => onStderr(String(chunk)));
  child.once?.("error", (error) => settle(-1, error));
  child.once?.("close", (code) => settle(Number.isInteger(code) ? code : -1));

  const send = (message) => {
    if (settled || !child.stdin?.writable) throw new Error("claude-stream-not-writable");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const stop = () => {
    if (settled || expectedStop) return closed;
    expectedStop = true;
    try { child.stdin?.end?.(); } catch {}
    try { child.kill?.("SIGTERM"); } catch {}
    killTimer = setTimeout(() => {
      try { child.kill?.("SIGKILL"); } catch {}
    }, 1_000);
    killTimer.unref?.();
    return closed;
  };

  return {
    child,
    signature,
    send,
    stop,
    closed,
    get stopped() { return settled; },
  };
}
