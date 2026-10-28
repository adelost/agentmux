// WHAT: Answers read-only tmux questions over one persistent control-mode client instead of starting a process each.
// WHY: Keeps the bridge's watchdogs from forking a 1.5 GB process per question (docs/DESIGN-pulse.md, row 116b).
//
// The adapter in core/tmux.mjs keeps building every command. This module only replaces its exec: a read-only
// question goes over the client, everything else (writes, shell syntax, multi-line text) and every question
// while the client is not ready goes to the process path, counted. The client attaches to its own session,
// amux-pulse, never to an agent's, because `amux sleep` and the window-size pin read agent sessions' attached
// clients. `tmux -N` makes it impossible for Pulse to start a tmux server, so it can never trigger the
// tmux-continuum restore of the whole fleet.

import { spawn } from "child_process";
import { esc } from "../../lib.mjs";

/** WHAT: Names the session the control client attaches to. WHY: Keeps agent sessions' attached-client counts unchanged. */
export const PULSE_SESSION = "amux-pulse";
/** WHAT: Defines the AMUX_PULSE_TRANSPORT values. WHY: Prevents an unknown mode from choosing a path silently. */
export const TRANSPORT_MODES = new Set(["exec", "shadow", "control"]);
const READ_ONLY_VERBS = new Set(["display-message", "capture-pane", "list-panes", "list-sessions", "list-windows", "has-session"]);
// These two print to a pane unless -p sends the answer to stdout.
const PRINTS_ONLY_WITH_P = new Set(["display-message", "capture-pane"]);
const MAX_REPLY_BYTES = 1024 * 1024;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

/**
 * WHAT: Parses an adapter-built command into words; null means a shell would treat it specially.
 * WHY: Keeps commands that rely on sh (pipes, redirects, $, double quotes) on the process path.
 */
export function shellWords(text) {
  const words = [];
  let word = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return null;
      word = (word ?? "") + text.slice(i + 1, close);
      i = close;
    } else if (c === "\\" && text[i + 1] === "'") {
      word = (word ?? "") + "'";
      i++;
    } else if (c === " " || c === "\t") {
      if (word !== null) words.push(word);
      word = null;
    } else if (/["$`;|&<>(){}\\*?~\[\]!#]/u.test(c)) {
      return null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/**
 * WHAT: Returns a read-only question's tmux arguments, or null when it must start a process.
 * WHY: Keeps writes, other sockets and shell syntax off the control connection (invariant I-1).
 */
export function readOnlyQuestion(cmd, socket) {
  const prefix = `tmux -S '${esc(socket)}' `;
  if (typeof cmd !== "string" || !cmd.startsWith(prefix)) return null;
  const args = cmd.slice(prefix.length);
  if (/[\r\n]/u.test(args)) return null;
  const words = shellWords(args);
  if (!words?.length || !READ_ONLY_VERBS.has(words[0])) return null;
  const flags = words.slice(1).filter((word) => /^-[A-Za-z]+$/u.test(word));
  if (PRINTS_ONLY_WITH_P.has(words[0]) && !flags.some((flag) => flag.includes("p"))) return null;
  const targetAt = words.indexOf("-t");
  return { args, verb: words[0], target: targetAt > 0 ? words[targetAt + 1] ?? null : null };
}

const failure = (message, fields) => Object.assign(new Error(message), { stdout: "", stderr: "", ...fields });

/**
 * WHAT: Builds the exec replacement: one control client, a FIFO of questions and an explicit connection state.
 * WHY: Separates how a question travels from who asks it, so callers keep exec's {stdout} and rejection shape.
 */
export function createControlTransport({
  socket,
  processExec,
  mode = "shadow",
  counters = null,
  sampleEvery = 20,
  timeoutMs = 3000,
  log = () => {},
  spawnClient = (args) => spawn("tmux", args, { stdio: ["pipe", "pipe", "pipe"] }),
  backoffMs = BACKOFF_MS,
} = {}) {
  if (!TRANSPORT_MODES.has(mode)) throw new Error(`AMUX_PULSE_TRANSPORT must be exec, shadow or control, not ${JSON.stringify(mode)}`);
  if (typeof processExec !== "function") throw new Error("control transport needs the process exec");
  let state = "idle";
  let reason = null;
  let client = null;
  let queue = [];
  let block = null;
  let carry = "";
  let attempts = 0;
  let reconnectTimer = null;
  let sampled = 0;
  let stopped = false;

  const record = (path, question) => counters?.record({ path, verb: question?.verb ?? null, target: question?.target ?? null });
  const setState = (next, why = null) => {
    if (state === next && reason === why) return;
    state = next;
    reason = why;
    counters?.setTransport({ mode, state, reason });
    log(`control client ${next}${why ? ` (${why})` : ""}`);
  };

  function rejectAll(error) {
    const pending = queue;
    queue = [];
    for (const job of pending) { clearTimeout(job.timer); job.reject(error); }
  }

  function broken(why) {
    if (state === "broken" || stopped) return;
    setState("broken", why);
    block = null;
    carry = "";
    const old = client;
    client = null;
    if (old) { old.stdout?.removeAllListeners(); old.removeAllListeners("exit"); old.kill("SIGKILL"); }
    rejectAll(failure(`tmux control client ${why}`, { killed: true, signal: "SIGTERM", code: null }));
    const delay = backoffMs[Math.min(attempts, backoffMs.length - 1)];
    attempts++;
    reconnectTimer = setTimeout(connect, delay);
    reconnectTimer.unref?.();
  }

  function finish(ended, ok) {
    if (state === "connecting") {
      if (ok) { attempts = 0; setState("ready"); }
      else broken(`attach refused: ${ended.lines.join(" ").slice(0, 120)}`);
      return;
    }
    if (ended.flags !== "1") return; // output of a command this client did not send
    const job = queue.shift();
    if (!job) { log(`reply without a question (${ended.lines.length} lines)`); return; }
    clearTimeout(job.timer);
    const text = ended.lines.join("\n");
    if (ended.bytes > MAX_REPLY_BYTES) job.reject(failure("stdout maxBuffer length exceeded", { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }));
    else if (ok) job.resolve({ stdout: ended.lines.length ? `${text}\n` : "", stderr: "" });
    else job.reject(failure(`Command failed: tmux ${job.args}\n${text}`, { code: 1, stderr: `${text}\n` }));
  }

  function onLine(line) {
    if (block) {
      const end = /^%(end|error) \d+ (\d+) \d+$/u.exec(line);
      if (end && end[2] === block.number) { const ended = block; block = null; finish(ended, end[1] === "end"); return; }
      block.lines.push(line);
      block.bytes += line.length + 1;
      return;
    }
    const begin = /^%begin \d+ (\d+) (\d+)$/u.exec(line);
    if (begin) { block = { number: begin[1], flags: begin[2], lines: [], bytes: 0 }; return; }
    if (line.startsWith("%exit")) broken(`exited: ${line.slice(5).trim() || "no reason"}`);
  }

  function connect() {
    reconnectTimer = null;
    if (stopped || mode === "exec") return;
    setState("connecting");
    const args = ["-N", "-S", socket, "-C", "new-session", "-A", "-s", PULSE_SESSION,
      "-f", "no-output,ignore-size", "sleep 2147483647"];
    let child;
    try { child = spawnClient(args); } catch (error) { broken(`spawn failed: ${error.message}`); return; }
    client = child;
    record("connect", null);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (client !== child) return;
      const lines = (carry + chunk).split("\n");
      carry = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.stderr?.on("data", (chunk) => log(`client stderr: ${String(chunk).trim().slice(0, 160)}`));
    child.stdin.on("error", (error) => { if (client === child) broken(`client stdin: ${error.message}`); });
    child.on("exit", (code) => { if (client === child) broken(`client exited with ${code}`); });
    child.on("error", (error) => { if (client === child) broken(`client error: ${error.message}`); });
    const attachTimer = setTimeout(() => { if (client === child && state === "connecting") broken(`no attach reply in ${timeoutMs} ms`); }, timeoutMs);
    attachTimer.unref?.();
  }

  function ask(question) {
    return new Promise((resolve, reject) => {
      const job = { args: question.args, resolve, reject, timer: null };
      job.timer = setTimeout(() => broken(`no reply in ${timeoutMs} ms`), timeoutMs);
      job.timer.unref?.();
      queue.push(job);
      client.stdin.write(`${question.args}\n`);
    });
  }

  const answerText = (outcome) => outcome.status === "fulfilled"
    ? `ok ${JSON.stringify(outcome.value.stdout).slice(0, 160)}`
    : `error ${JSON.stringify(String(outcome.reason?.stderr || outcome.reason?.message || "").trim()).slice(0, 160)}`;
  const sameAnswer = (a, b) => a.status === b.status && (a.status === "fulfilled"
    ? a.value.stdout === b.value.stdout
    : String(a.reason?.stderr || "").trim() === String(b.reason?.stderr || "").trim());

  function shadow(cmd, question) {
    record("process", question);
    const answer = processExec(cmd);
    if (state === "ready" && ++sampled % sampleEvery === 0) {
      record("shadow", question);
      Promise.allSettled([answer, ask(question)]).then(([processOutcome, controlOutcome]) => {
        if (sameAnswer(processOutcome, controlOutcome)) return;
        counters?.disagree({ verb: question.verb, target: question.target,
          process: answerText(processOutcome), control: answerText(controlOutcome) });
        log(`shadow disagreement ${question.verb} ${question.target ?? "-"}: exec=${answerText(processOutcome)} control=${answerText(controlOutcome)}`);
      });
    }
    return answer;
  }

  /** WHAT: Runs one tmux command line the way tmuxExec did. WHY: Keeps every caller unchanged while the path changes. */
  function exec(cmd) {
    const question = mode === "exec" ? null : readOnlyQuestion(cmd, socket);
    if (!question) { record("process", null); return processExec(cmd); }
    if (mode === "shadow") return shadow(cmd, question);
    if (state !== "ready") { record("degraded", question); return processExec(cmd); }
    record("control", question);
    return ask(question);
  }

  connect();
  return {
    exec,
    state: () => ({ mode, state, reason, pending: queue.length }),
    clientPid: () => client?.pid ?? null,
    stop() {
      stopped = true;
      clearTimeout(reconnectTimer);
      const old = client;
      client = null;
      rejectAll(failure("tmux control transport stopped", { killed: true, signal: "SIGTERM", code: null }));
      if (old) { old.removeAllListeners("exit"); old.stdin.end(); old.kill("SIGTERM"); }
      setState("stopped");
    },
  };
}
