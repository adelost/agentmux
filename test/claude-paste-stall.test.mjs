import { feature, component, expect } from "bdd-vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createAgent } from "../agent.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { recoverSubmittedTui } from "../core/submitted-tui-recovery.mjs";

// Observed with the real Claude Code 2.1.295 in an isolated tmux on 2026-10-10: tmux pastes amux's
// line breaks as CR, Claude splits a paste into pieces only at LF, and a piece that ends in an image
// extension without being an absolute path makes Claude run this lookup with no time limit. While it
// runs the footer says "Pasting…" and Enter is held; when the lookup fails the paste lands and the
// held Enter is dropped. On WSLg the xclip under it blocked skyvw:0 for over six hours (job 4513bc1d).
const PATH_LOOKUP = "xclip -selection clipboard -t text/plain -o 2>/dev/null || wl-paste 2>/dev/null";
const RULE = "─".repeat(84);
const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/iu;
const STALLED_JOB = "[from lsrc:1]\n\n/home/adelost/lsrc/.artifacts/cutkit-quality-2026-10-09/e283-share/e283-fore-efter-390.png\n";
const QUESTION = "[transcribed voice] Hej, hur har det gått? Har ni jobbat hela natten?";

const asksClipboardForPath = (text) => text.split(/ (?=\/|[A-Za-z]:\\)/u)
  .flatMap((piece) => piece.split("\n")).map((piece) => piece.trim())
  .some((piece) => IMAGE_FILE.test(piece) && !isAbsolute(piece));

// The kernel names this process "claude", like the fleet's native binary. It starts the lookup the way
// Claude does, as its own /bin/sh child; "tool" starts the same script one shell deeper, as a Bash tool would.
const FAKE_CLAUDE = `
const { spawn } = require("node:child_process");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const child = line === "tool"
    ? spawn("/bin/sh", ["-c", ${JSON.stringify(`/bin/sh -c '${PATH_LOOKUP}'; :`)}], { stdio: "ignore" })
    : spawn("/bin/sh", ["-c", ${JSON.stringify(PATH_LOOKUP)}], { stdio: ["ignore", "pipe", "ignore"] });
  child.on("exit", () => process.stdout.write("exited " + child.pid + "\\n"));
  process.stdout.write("started " + child.pid + "\\n");
});
`;

/** Every live descendant of one process, children first. */
function descendants(root) {
  const parents = new Map();
  for (const name of readdirSync("/proc").filter((entry) => /^\d+$/u.test(entry))) {
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      parents.set(Number(name), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch { /* the process ended while the table was read */ }
  }
  const below = (pid) => [...parents].filter(([, ppid]) => ppid === pid).flatMap(([child]) => [child, ...below(child)]);
  return below(root);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** A Claude pane driven through the real agent transport, with a real clipboard lookup that never answers. */
function claudePane() {
  const root = mkdtempSync(join(tmpdir(), "amux-paste-stall-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "xclip"), "#!/bin/sh\nexec sleep 120\n", { mode: 0o755 });
  writeFileSync(join(root, "claude"), `#!${process.execPath}\n${FAKE_CLAUDE}`, { mode: 0o755 });
  writeFileSync(join(root, "agents.yaml"), `probe:\n  dir: ${root}\n  panes:\n    - {cmd: claude}\n`);
  const claude = spawn(join(root, "claude"), [], {
    stdio: ["pipe", "pipe", "ignore"],
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}` },
  });
  // dropEnters: Claude drops that many Enters without submitting, as skyvw:0 did at 01:29:08Z on 23 Oct.
  const pane = { composer: "", lookup: null, submitted: [], pastes: 0, calls: [], expansions: new Map(), dropEnters: 0 };
  let current = claude;
  const buffers = new Map();
  const started = [];
  const lookups = [];

  function land() {
    const { text } = pane.lookup;
    pane.lookup = null;                           // Claude drops an Enter it held during the lookup
    const breaks = (text.match(/\r\n|\r|\n/gu) || []).length;
    const shown = breaks ? `[Pasted text #${++pane.pastes} +${breaks} lines]` : text;
    pane.expansions.set(shown, text.replace(/\r/gu, "\n"));
    pane.composer += shown;
  }
  createInterface({ input: claude.stdout }).on("line", (line) => {
    const [kind, pid] = line.split(" ");
    if (kind === "started") started.shift()?.(Number(pid));
    if (kind === "exited" && pane.lookup?.pid === Number(pid)) land();
  });
  const startLookup = (kind) => new Promise((resolve) => {
    started.push(resolve);
    claude.stdin.write(`${kind}\n`);
  });

  async function paste(text) {
    if (!asksClipboardForPath(text)) {
      pane.lookup = { pid: null, text };
      land();
      return;
    }
    const pid = await startLookup("lookup");
    lookups.push(pid);
    pane.lookup = { pid, text };
  }

  function submit() {
    let text = pane.composer;
    for (const [shown, full] of pane.expansions) text = text.replace(shown, full);
    pane.submitted.push(text);
    pane.composer = "";
  }

  const screen = () => [
    "⏺ Earlier turn finished.",
    RULE, `❯ ${pane.composer}`, RULE,
    pane.lookup ? "  Pasting…" : "  ⏵⏵ bypass permissions on · ← for agents",
  ].join("\n");

  const agent = createAgent({
    configPath: join(root, "agents.yaml"),
    tmuxSocket: "/unused",
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
    run: async () => ({ stdout: "" }),
    tmuxExec: async (command) => {
      pane.calls.push(command);
      if (command.includes("#{pane_current_command}")) return { stdout: "claude\n" };
      if (command.includes("#{pane_pid}")) return { stdout: `${current.pid}\n` };
      if (command.includes("#{pane_in_mode}") || command.includes("#{pane_dead}")) return { stdout: "0\n" };
      if (command.includes("capture-pane")) return { stdout: screen() };
      const load = command.match(/load-buffer -b '([^']+)' '([^']+)'/u);
      if (load) buffers.set(load[1], readFileSync(load[2], "utf8"));
      const pasted = command.match(/paste-buffer .*-b '([^']+)'/u);
      if (pasted) await paste(buffers.get(pasted[1]).replace(/\n/gu, "\r"));
      const typed = command.match(/ -l -- '(.*)'$/su);
      if (typed) pane.composer += typed[1];
      const erased = (command.match(/\bBSpace\b/gu) || []).length;
      if (erased) pane.composer = pane.composer.slice(0, Math.max(0, pane.composer.length - erased));
      if (/send-keys.* Enter$/u.test(command) && !pane.lookup) {
        if (pane.dropEnters > 0) pane.dropEnters--;
        else submit();
      }
      return { stdout: "" };
    },
  });

  async function clean() {
    for (const process_ of new Set([claude, current])) {
      for (const pid of descendants(process_.pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
      process_.kill("SIGKILL");
    }
    rmSync(root, { recursive: true, force: true });
  }

  return {
    agent, pane, claude, lookups, clean, root,
    /** A paste that reached Claude before this test's delivery, still waiting on its lookup. */
    pasteEarlier: (text) => paste(text.replace(/\n/gu, "\r")),
    toolLookup: () => startLookup("tool"),
    /** Claude starts again in the same pane: a new process whose paste counter starts over, the composer kept. */
    newClaudeProcess: () => { current = spawn(join(root, "claude"), [], { stdio: ["pipe", "ignore", "ignore"] }); },
  };
}

const deliver = (fixture, text, options = {}) => fixture.agent
  .sendOnly("probe", text, 0, { existingOnly: true, ...options })
  .then(() => null, (error) => error.message);

const restarted = ({ calls }) => calls.some((call) => /respawn-pane|kill-pane|kill-session|new-session/u.test(call));

feature("a Claude paste that waits on the clipboard never holds delivery", () => {
  // skyvw:0's decision 2026-10-10 under Mattias's "bestäm själv hur de ska fixas": amux never pastes text Claude
  // reads as an image path, so delivery itself starts no clipboard lookup.
  for (const [name, message] of [["lsrc:1's image path from job 4513bc1d", STALLED_JOB],
    ["a message whose last line is /a.png", "[from skyvw:0]\n\nbilden ligger här:\n/a.png\n"]]) {
    component(`${name} is pasted in parts, starts no clipboard lookup and is submitted once`, {
      given: ["a Claude pane whose clipboard lookup would never answer", () => claudePane()],
      when: ["the message is delivered", async (fixture) => deliver(fixture, message)],
      then: ["no lookup ran and exactly the message was submitted once", async (error, fixture) => {
        try {
          expect(error).toBeNull();
          expect(fixture.lookups).toEqual([]);
          expect(fixture.pane.submitted).toEqual([message]);
          expect(fixture.pane.calls.filter((call) => call.includes("paste-buffer"))).toHaveLength(2);
          expect(restarted(fixture.pane)).toBe(false);
        } finally { await fixture.clean(); }
      }],
    });
  }

  // lsrc:3 review 2026-10-10: a landed collapsed paste is never attributed by its line count.
  component("the transport reports a held paste as pasting and a landed collapsed paste as foreign", {
    given: ["an earlier paste still waiting on its lookup", async () => {
      const fixture = claudePane();
      await fixture.pasteEarlier(STALLED_JOB);
      return fixture;
    }],
    when: ["reading the transport state before and after the lookup ends", async (fixture) => {
      const held = await fixture.agent.promptTransportState("probe", 0, STALLED_JOB);
      for (const pid of [...descendants(fixture.lookups[0]), fixture.lookups[0]]) process.kill(pid, "SIGTERM");
      for (let tries = 0; tries < 100 && fixture.pane.lookup; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
      return { held: held.state, landed: (await fixture.agent.promptTransportState("probe", 0, STALLED_JOB)).state };
    }],
    then: ["neither state invites a restart or a second paste", async (states, fixture) => {
      try { expect(states).toEqual({ held: "pasting", landed: "foreign" }); } finally { await fixture.clean(); }
    }],
  });

  component("maintenance never types /compact into a composer that is still pasting", {
    given: ["an earlier paste still waiting on its lookup", async () => {
      const fixture = claudePane();
      await fixture.pasteEarlier(STALLED_JOB);
      return fixture;
    }],
    when: ["the nightly or cold compact sends /compact", async (fixture) => deliver(fixture, "/compact", {
      maintenanceGuard: async () => {},
    })],
    then: ["nothing is typed, nothing is submitted and the paste is left for its owner", async (error, fixture) => {
      try {
        expect(fixture.pane.composer).toBe("");
        expect(error).toMatch(/Pasting/u);
        expect(fixture.pane.submitted).toEqual([]);
        expect(alive(fixture.lookups[0])).toBe(true);
      } finally { await fixture.clean(); }
    }],
  });

  // lsrc:3 review 2026-10-10: the stalled paste cannot be proven to be the earlier job's text, so it
  // stays a draft: no job submits it, nothing types after it, and nothing pastes it again.
  component("Mattias's next message frees the pane and the landed paste stays a draft no one submits", {
    given: ["an earlier amux paste still waiting on its lookup", async () => {
      const fixture = claudePane();
      await fixture.pasteEarlier(STALLED_JOB);
      return fixture;
    }],
    when: ["his message is sent, the earlier job retries its draft, and his message is retried", async (fixture) => ({
      first: await deliver(fixture, QUESTION),
      composerAfterFirst: fixture.pane.composer,
      retry: await deliver(fixture, STALLED_JOB, { knownDrafted: true }),
      second: await deliver(fixture, QUESTION),
      lookupAlive: alive(fixture.lookups[0]),
    })],
    then: ["the hang is over, nothing is submitted, merged or pasted again, and the draft is intact", async (result, fixture) => {
      try {
        expect(fixture.pane.submitted).toEqual([]);
        expect(result.lookupAlive).toBe(false);
        expect(result.first).toMatch(/draft amux did not type/u);
        expect(result.composerAfterFirst).toBe("[Pasted text #1 +3 lines]");
        expect(result.retry).toMatch(/refusing to paste it again/u);
        expect(result.second).toMatch(/draft amux did not type/u);
        expect(fixture.pane.composer).toBe("[Pasted text #1 +3 lines]");
        expect(fixture.pane.calls.filter((call) => call.includes("paste-buffer"))).toHaveLength(0);
        expect(restarted(fixture.pane)).toBe(false);
      } finally { await fixture.clean(); }
    }],
  });

  component("a human paste that waited on the clipboard stays an untouched draft", {
    given: ["a person's paste of a screenshot name waiting on its lookup", async () => {
      const fixture = claudePane();
      await fixture.pasteEarlier("Kolla den här\nskärmbild.png");
      return fixture;
    }],
    when: ["amux delivers a message", (fixture) => deliver(fixture, QUESTION)],
    then: ["the message waits and the person's text is neither sent nor erased", async (error, fixture) => {
      try {
        expect(fixture.pane.composer).toBe("[Pasted text #1 +1 lines]");
        expect(error).toMatch(/draft amux did not type/u);
        expect(fixture.pane.expansions.get("[Pasted text #1 +1 lines]")).toBe("Kolla den här\nskärmbild.png");
        expect(fixture.pane.submitted).toEqual([]);
      } finally { await fixture.clean(); }
    }],
  });

  component("a lookup that a tool shell started is not Claude's and is never signalled", {
    given: ["Claude's own stalled lookup from an earlier paste and the same script under a tool shell", async () => {
      const fixture = claudePane();
      await fixture.pasteEarlier(STALLED_JOB);
      const tool = await fixture.toolLookup();
      return { fixture, tool };
    }],
    when: ["the next message is delivered", async ({ fixture, tool }) => ({
      error: await deliver(fixture, QUESTION),
      ownAlive: alive(fixture.lookups[0]),
      toolAlive: alive(tool),
      toolChildren: descendants(tool).length,
    })],
    then: ["only Claude's own lookup ended", async (result, { fixture }) => {
      try {
        expect(result.ownAlive).toBe(false);
        expect(result.toolAlive).toBe(true);
        expect(result.toolChildren).toBeGreaterThan(0);
        expect(result.error).toMatch(/draft amux did not type/u);
      } finally { await fixture.clean(); }
    }],
  });
});

// lsrc:3 review 2026-10-10: "Radantal är inte identitet." A job that was submitted is no proof that a later
// collapsed paste with the same line count is its text, so recovery must not Enter, erase or restart it.
feature("a collapsed paste amux cannot attribute is never submitted, erased or restarted", () => {
  component("a person's same-length collapsed draft after a submitted job gets nothing and no receipt", {
    given: ["a job submitted ten minutes ago and a person's own two-line paste in an idle composer", () => {
      const fixture = claudePane();
      const oldHome = process.env.HOME;
      const home = mkdtempSync(join(tmpdir(), "amux-paste-owner-home-"));
      process.env.HOME = home;
      const paneDir = join(fixture.root, ".agents", "0");
      const project = join(home, ".claude", "projects", paneDir.replace(/[\/\.]/gu, "-"));
      mkdirSync(project, { recursive: true });
      const turnAt = new Date(Date.now() - 20 * 60_000).toISOString();
      writeFileSync(join(project, "session.jsonl"), [
        { type: "user", timestamp: turnAt, message: { role: "user", content: "earlier turn" } },
        { type: "assistant", timestamp: turnAt, message: { role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
          content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } } },
      ].map((row) => JSON.stringify(row)).join("\n") + "\n");
      const queue = createDeliveryQueue({ rootDir: join(home, "queue") });
      const created = queue.enqueue({ agentName: "probe", pane: 0, text: "first private message\n/a.png" });
      const job = queue.update(created, { status: "submitted", submittedAt: Date.now() - 10 * 60_000,
        echoCursor: { kind: "claude-prompt-events-v1", positions: {} } });
      fixture.pane.composer = "[Pasted text #7 +1 lines]";
      return { fixture, queue, job, restore: () => { process.env.HOME = oldHome; rmSync(home, { recursive: true, force: true }); } };
    }],
    when: ["recovery visits the job twice", async ({ fixture, queue, job }) => {
      const pass = (current) => recoverSubmittedTui({
        job: current, agent: fixture.agent, queue, now: Date.now, onRecovered: () => {},
        exactEcho: async () => false, acknowledge: () => { throw new Error("no receipt exists"); },
      });
      await pass(job);
      await pass(queue.read("probe", 0, job.id));
      return queue.read("probe", 0, job.id);
    }],
    then: ["no Enter, erase or restart, the draft is intact and the job has no receipt", async (current, { fixture, restore }) => {
      try {
        const keys = fixture.pane.calls.filter((call) => /send-keys/u.test(call));
        expect(fixture.pane.submitted).toEqual([]);
        expect(keys.filter((call) => /Enter$/u.test(call))).toEqual([]);
        expect(keys.filter((call) => /BSpace|C-u|Escape/u.test(call))).toEqual([]);
        expect(restarted(fixture.pane)).toBe(false);
        expect(fixture.pane.composer).toBe("[Pasted text #7 +1 lines]");
        expect(current).toMatchObject({ status: "submitted", acknowledgedAt: null });
      } finally { restore(); await fixture.clean(); }
    }],
  });
});

// lsrc:0 for Mattias 2026-10-23: skyvw:0 took nothing from 01:29 to 04:50Z. amux pasted skyvw:6's four-line job
// e505e8a0, Claude showed "[Pasted text #95 +3 lines]" and dropped the Enter (no prompt, no queue entry in its
// journal). amux could not tell its own paste from a person's, so the job waited 60 min for a receipt and then
// every later job refused the pane as holding "a draft amux did not type".
const FOUR_LINES = "[from skyvw:6]\n\nUtfall b i den lugna 3x3-mätningen.\nSamma fil och samma fördröjning.";

/** A HOME whose session ended its last turn, so the pane reads idle; and a queue for the submitted job. */
function idleHome(fixture) {
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "amux-own-paste-home-"));
  process.env.HOME = home;
  const project = join(home, ".claude", "projects", join(fixture.root, ".agents", "0").replace(/[\/\.]/gu, "-"));
  mkdirSync(project, { recursive: true });
  const turnAt = new Date(Date.now() - 20 * 60_000).toISOString();
  writeFileSync(join(project, "session.jsonl"), [
    { type: "user", timestamp: turnAt, message: { role: "user", content: "earlier turn" } },
    { type: "assistant", timestamp: turnAt, message: { role: "assistant", model: "claude-opus-5-5", stop_reason: "end_turn",
      content: [{ type: "text", text: "done" }], usage: { input_tokens: 1, output_tokens: 1 } } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { queue: createDeliveryQueue({ rootDir: join(home, "queue") }),
    restore: () => { process.env.HOME = oldHome; rmSync(home, { recursive: true, force: true }); } };
}

/** Delivers FOUR_LINES while Claude drops `drops` Enters, and keeps what amux recorded about its paste. */
async function deliverDropped(fixture, drops) {
  fixture.pane.dropEnters = drops;
  let owned = null;
  const error = await deliver(fixture, FOUR_LINES, { onDrafted: async (facts) => { owned = facts?.claudeOwnedPaste ?? null; } });
  return { error, owned };
}

/** A job submitted three minutes ago with what amux recorded about its paste, visited by recovery once. */
async function recoverAfterThreeMinutes(fixture, home, owned) {
  const created = home.queue.enqueue({ agentName: "probe", pane: 0, text: FOUR_LINES });
  const job = home.queue.update(created, { status: "submitted", submittedAt: Date.now() - 3 * 60_000,
    echoCursor: { kind: "claude-prompt-events-v1", positions: {} }, metadata: { claudeOwnedPaste: owned } });
  await recoverSubmittedTui({
    job, agent: fixture.agent, queue: home.queue, now: Date.now, onRecovered: () => {},
    exactEcho: async () => false, acknowledge: () => { throw new Error("no receipt exists"); },
  });
  return home.queue.read("probe", 0, job.id);
}

const enters = ({ calls }) => calls.filter((call) => /send-keys.* Enter$/u.test(call)).length;

feature("amux's own collapsed paste whose Enter Claude dropped is submitted under its own job", () => {
  component("one dropped Enter: the bounded rescue submits the job's own collapsed paste once", {
    given: ["an idle Claude pane that drops the first Enter", () => {
      const fixture = claudePane();
      return { fixture, home: idleHome(fixture) };
    }],
    when: ["skyvw:6's four-line job is delivered", ({ fixture }) => deliverDropped(fixture, 1)],
    then: ["the message is submitted exactly once and the composer is empty", async ({ error }, { fixture, home }) => {
      try {
        expect(error).toBeNull();
        expect(fixture.pane.submitted).toEqual([FOUR_LINES]);
        expect(fixture.pane.composer).toBe("");
        expect(restarted(fixture.pane)).toBe(false);
      } finally { home.restore(); await fixture.clean(); }
    }],
  });

  component("every Enter dropped: recovery recognises the job's own paste and sends one Enter", {
    given: ["the job's paste left in an idle composer after its Enter and both rescue Enters were dropped", async () => {
      const fixture = claudePane();
      const home = idleHome(fixture);
      return { fixture, delivered: await deliverDropped(fixture, 3), home };
    }],
    when: ["recovery visits the job three minutes after its submit", async ({ fixture, delivered, home }) => ({
      composerBefore: fixture.pane.composer,
      job: await recoverAfterThreeMinutes(fixture, home, delivered.owned),
    })],
    then: ["the paste is submitted once, nothing is erased, restarted or pasted again", async (result, { fixture, home }) => {
      try {
        expect(result.composerBefore).toBe("[Pasted text #1 +3 lines]");
        expect(fixture.pane.submitted).toEqual([FOUR_LINES]);
        expect(result.job.metadata.submittedRecoveryKind).toBe("exact-draft-enter");
        expect(fixture.pane.calls.filter((call) => /BSpace|C-u|Escape/u.test(call))).toEqual([]);
        expect(fixture.pane.calls.filter((call) => call.includes("paste-buffer"))).toHaveLength(1);
        expect(restarted(fixture.pane)).toBe(false);
      } finally { home.restore(); await fixture.clean(); }
    }],
  });

  component("the same marker under a new Claude process is not amux's and gets no Enter", {
    given: ["the job's paste left in the composer, then a new Claude process in the pane", async () => {
      const fixture = claudePane();
      const home = idleHome(fixture);
      const delivered = await deliverDropped(fixture, 3);
      fixture.newClaudeProcess();
      return { fixture, delivered, home };
    }],
    when: ["recovery visits the job three minutes after its submit", async ({ fixture, delivered, home }) => ({
      entersBefore: enters(fixture.pane),
      job: await recoverAfterThreeMinutes(fixture, home, delivered.owned),
    })],
    then: ["no Enter, erase or restart, and the draft is intact", async (result, { fixture, home }) => {
      try {
        expect(enters(fixture.pane)).toBe(result.entersBefore);
        expect(fixture.pane.submitted).toEqual([]);
        expect(fixture.pane.composer).toBe("[Pasted text #1 +3 lines]");
        expect(restarted(fixture.pane)).toBe(false);
        expect(result.job).toMatchObject({ status: "submitted", acknowledgedAt: null });
      } finally { home.restore(); await fixture.clean(); }
    }],
  });
});
