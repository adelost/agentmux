// Guards Pulse B1 (docs/DESIGN-pulse.md §12): read-only tmux questions answered over one control-mode client.
// Integration level: a private tmux 3.2 server per test, always started with `-f /dev/null`, because the
// user's tmux-continuum restores the whole fleet into any new server that loads ~/.tmux.conf (2026-10-28).

import { execFile, execFileSync, exec as execCallback } from "child_process";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { feature, integration, component, expect } from "bdd-vitest";
import { createControlTransport, readOnlyQuestion, PULSE_SESSION } from "./control-transport.mjs";
import { createIoCounters } from "./io-counters.mjs";
import { createTmuxAdapter } from "../tmux.mjs";

const execText = promisify(execCallback);
const execFileText = promisify(execFile);

function privateTmux({ start = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pulse-"));
  const socket = join(dir, "s");
  if (start) {
    execFileSync("tmux", ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "work", "-x", "120", "-y", "30", "bash --norc"]);
    execFileSync("tmux", ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "o'brien", "bash --norc"]);
  }
  const processCalls = [];
  const processExec = (cmd) => { processCalls.push(cmd); return execText(cmd, { timeout: 3000 }); };
  const close = () => {
    try { execFileSync("tmux", ["-S", socket, "kill-server"], { stdio: "ignore" }); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, socket, processCalls, processExec, close };
}

async function until(check, ms = 3000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

async function readyTransport(options) {
  const tmux = privateTmux();
  const counters = createIoCounters();
  const transport = createControlTransport({ socket: tmux.socket, processExec: tmux.processExec, counters, mode: "control",
    timeoutMs: 1000, backoffMs: [100], ...options });
  await until(() => transport.state().state === "ready");
  return { ...tmux, counters, transport, close: () => { transport.stop(); tmux.close(); } };
}

const settle = (promise) => promise.then((value) => ({ ok: true, stdout: value.stdout }),
  (error) => ({ ok: false, stderr: String(error.stderr).trim() }));

feature("Pulse control transport", () => {
  integration("answers the same as exec", {
    given: ["a ready transport and the plain process exec on one private server", () => readyTransport()],
    when: ["the adapter asks the same questions both ways", async (f) => {
      const viaControl = createTmuxAdapter({ socket: f.socket, exec: f.transport.exec });
      const viaProcess = createTmuxAdapter({ socket: f.socket, exec: f.processExec });
      const questions = [
        (t) => t.display("o'brien", "#{session_name}|#{pane_current_command}|$HOME|\"q\""),
        (t) => t.capture("work", { lines: 5 }),
        (t) => t.paneRows("work"),
        (t) => t.hasSession("o'brien"),
        (t) => t.hasSession("nope"),
        (t) => t.display("nope", "#{pane_id}"),
        (t) => t.display("work", "ä ö 🐢 #{window_width}x#{window_height}"),
      ];
      const pairs = [];
      for (const ask of questions) pairs.push([await settle(Promise.resolve().then(() => ask(viaProcess))), await settle(Promise.resolve().then(() => ask(viaControl)))]);
      return pairs;
    }],
    then: ["every answer and every rejection matches", (pairs) => {
      for (const [process, control] of pairs) expect(control).toEqual(process);
    }],
    cleanup: (f) => f.close(),
  });

  integration("starts no process for read-only questions", {
    given: ["a ready transport", () => readyTransport()],
    when: ["50 read-only questions are asked", async (f) => {
      const t = createTmuxAdapter({ socket: f.socket, exec: f.transport.exec });
      for (let i = 0; i < 50; i++) await t.paneDead("work");
      return f;
    }],
    then: ["no process started and the counters say so", (f) => {
      expect(f.processCalls).toEqual([]);
      expect(f.counters.snapshot().totals).toMatchObject({ control: 50, process: 0, degraded: 0 });
    }],
    cleanup: (f) => f.close(),
  });

  component("routes writes and multi-line commands to exec", {
    given: ["a ready transport", () => readyTransport()],
    when: ["a write, a multi-line text, shell syntax and a display without -p are sent", async (f) => {
      const prefix = `tmux -S '${f.socket}' `;
      await f.transport.exec(`${prefix}send-keys -t 'work' -l 'x'`);
      await f.transport.exec(`${prefix}display-message -t 'work' -p 'a\nb'`).catch(() => {});
      await f.transport.exec(`${prefix}list-sessions 2>/dev/null`);
      await f.transport.exec(`${prefix}display-message -t 'work' 'shown in the pane'`);
      return f;
    }],
    then: ["all four started a process and none went over the client", (f) => {
      expect(f.processCalls).toHaveLength(4);
      expect(f.counters.snapshot().totals.control).toBe(0);
      expect(readOnlyQuestion(`tmux -S '${f.socket}' capture-pane -t 'work' -J -p -S -50`, f.socket)?.verb).toBe("capture-pane");
    }],
    cleanup: (f) => f.close(),
  });

  integration("matches replies in order under a burst of 200 questions", {
    given: ["a ready transport", () => readyTransport()],
    when: ["200 different questions are asked at once", (f) => {
      const t = createTmuxAdapter({ socket: f.socket, exec: f.transport.exec });
      return Promise.all(Array.from({ length: 200 }, (_, i) => t.display("work", `n=${i}`)));
    }],
    then: ["each gets its own answer", (answers) => {
      expect(answers).toEqual(Array.from({ length: 200 }, (_, i) => `n=${i}`));
    }],
    cleanup: (f) => f.close(),
  });

  component("fails pending questions and degrades to exec when the client stops replying", {
    given: ["a ready transport whose tmux server is then frozen", async () => {
      const f = await readyTransport();
      // The server writes replies straight to the client's stdout fd, so only a frozen server stops them.
      f.serverPid = Number((await execFileText("tmux", ["-S", f.socket, "display-message", "-p", "#{pid}"])).stdout);
      process.kill(f.serverPid, "SIGSTOP");
      return f;
    }],
    when: ["one question waits past the limit, the server thaws, then another is asked", async (f) => {
      const t = createTmuxAdapter({ socket: f.socket, exec: f.transport.exec });
      const started = performance.now();
      const first = await settle(t.display("work", "#{pane_id}"));
      const waitedMs = performance.now() - started;
      process.kill(f.serverPid, "SIGCONT");
      const second = await t.display("work", "second");
      const reconnected = await until(() => f.transport.state().state === "ready");
      return { first, waitedMs, second, reconnected, totals: f.counters.snapshot().totals };
    }],
    then: ["the first fails within the limit, the second is answered by a process, and the client comes back", (r) => {
      expect(r.first.ok).toBe(false);
      expect(r.waitedMs).toBeLessThan(2000);
      expect(r.second).toBe("second");
      expect(r.totals.degraded).toBeGreaterThanOrEqual(1);
      expect(r.reconnected).toBe(true);
    }],
    cleanup: (f) => f.close(),
  });

  integration("reconnects after its session is killed", {
    given: ["a ready transport", () => readyTransport()],
    when: ["its own session is killed and a question is asked after it comes back", async (f) => {
      await execFileText("tmux", ["-S", f.socket, "kill-session", "-t", PULSE_SESSION]);
      const dropped = await until(() => f.transport.state().state !== "ready", 2000);
      const back = await until(() => f.transport.state().state === "ready");
      const answer = await createTmuxAdapter({ socket: f.socket, exec: f.transport.exec }).display("work", "back");
      return { dropped, back, answer, sessions: (await execFileText("tmux", ["-S", f.socket, "list-sessions", "-F", "#{session_name}"])).stdout };
    }],
    then: ["it noticed, came back on its own session, and answers over the client", (r) => {
      expect(r).toMatchObject({ dropped: true, back: true, answer: "back" });
      expect(r.sessions.trim().split("\n").sort()).toEqual([PULSE_SESSION, "o'brien", "work"].sort());
    }],
    cleanup: (f) => f.close(),
  });

  component("logs a shadow disagreement with both answers", {
    given: ["a shadow transport whose process answer is wrong", async () => {
      const f = privateTmux();
      const lines = [];
      const counters = createIoCounters();
      const transport = createControlTransport({ socket: f.socket, processExec: async () => ({ stdout: "wrong\n", stderr: "" }),
        counters, mode: "shadow", sampleEvery: 1, timeoutMs: 1000, backoffMs: [100], log: (line) => lines.push(line) });
      await until(() => transport.state().state === "ready");
      return { ...f, lines, counters, transport, close: () => { transport.stop(); f.close(); } };
    }],
    when: ["a question is asked", async (f) => {
      const answer = await createTmuxAdapter({ socket: f.socket, exec: f.transport.exec }).display("work", "#{session_name}");
      await until(() => f.counters.snapshot().disagreementCount > 0);
      return { answer, f };
    }],
    then: ["the caller got the process answer and the difference names both", ({ answer, f }) => {
      expect(answer).toBe("wrong");
      expect(f.lines.join("\n")).toMatch(/shadow disagreement display-message work: exec=ok "wrong\\n" control=ok "work\\n"/u);
    }],
    cleanup: (f) => f.close(),
  });

  integration("never starts a tmux server", {
    given: ["a socket with no server behind it", () => privateTmux({ start: false })],
    when: ["a transport tries to connect", async (f) => {
      const transport = createControlTransport({ socket: f.socket, processExec: f.processExec, mode: "control", timeoutMs: 500, backoffMs: [5000] });
      const settled = await until(() => transport.state().state === "broken");
      transport.stop();
      return { settled, socketExists: existsSync(f.socket) };
    }],
    then: ["it stays broken and no server or socket appears", (r) => {
      expect(r).toEqual({ settled: true, socketExists: false });
    }],
    cleanup: (f) => f.close(),
  });
});
