// Claude Code's paste handler can wait on a clipboard lookup with no time limit.
//
// Upstream boundary (Claude Code 2.1.295 and 2.1.296, closed source, observed in an isolated tmux on
// 2026-10-10): a paste piece that ends in .png/.jpg/.jpeg/.gif/.webp without being an absolute path
// makes Claude run `xclip -selection clipboard -t text/plain -o 2>/dev/null || wl-paste 2>/dev/null`
// and await it with no timeout. tmux pastes amux's line breaks as CR and Claude splits pieces only at
// LF, so any multi-line message that ends in an image path is one relative "path". While the lookup
// runs the footer says "Pasting…" and Enter is held; when it fails the paste lands and the held Enter
// is dropped. On WSLg xclip blocked in poll for hours, and skyvw:0 took no delivery from 22:07Z to
// 04:48Z (job 4513bc1d, 2026-10-09). amux cannot add the timeout inside Claude, so it waits a bounded
// time and then ends exactly that lookup, never Claude, its process group or anyone else's process.

import { readFileSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { COMPOSER_RULE_RE, composerDraft } from "./dialects.mjs";

// About five seconds at the transport's 250 ms poll. A healthy lookup answers in milliseconds.
const CLAUDE_PASTE_SETTLE_POLLS = 20;
// About three seconds for the paste to land once the lookup has ended.
const CLAUDE_PASTE_LAND_POLLS = 12;
const POLL_MS = 250;

const PASTING_FOOTER_RE = /^Pasting…(?:\s{2,}\S.*)?$/u;
const COLLAPSED_PASTE_RE = /\[Pasted text #\d+(?: \+\d+ lines?)?\]/u;
// Claude's own Linux clipboard scripts (path lookup, image check, image save) all start with an xclip
// read and fall back to wl-paste. The same script run through a tool shell is not Claude's own child.
const CLAUDE_CLIPBOARD_SCRIPT_RE = /^xclip -selection clipboard -t \S+ -o\b.*\|\| wl-paste\b/su;
const SHELL_RE = /^(?:\/(?:usr\/)?bin\/)?(?:sh|dash|bash)$/u;
const processGone = (error) => ["ENOENT", "ESRCH"].includes(error?.code);

/** WHAT: Checks whether Claude's footer shows "Pasting…" right under its composer. WHY: Keeps keystrokes and Enter out of a paste Claude holds and then drops. */
export function claudeComposerIsPasting(screen) {
  const lines = String(screen || "").split("\n").map((line) => line.trim());
  const prompt = lines.findLastIndex((line) => line.startsWith("❯"));
  const ruleBelow = lines.findIndex((line, index) => index > prompt && COMPOSER_RULE_RE.test(line));
  return prompt >= 0 && ruleBelow > prompt
    && lines.slice(ruleBelow + 1, ruleBelow + 4).some((line) => PASTING_FOOTER_RE.test(line));
}

// lsrc:3 review 2026-10-10: "Radantal är inte identitet." The placeholder hides the text and its number is
// Claude's own session counter, so a collapsed paste is real content that amux never claims as its draft.
/** WHAT: Checks whether Claude's composer holds a collapsed paste whose text the screen hides. WHY: Keeps an unattributable paste from reading as empty or as amux's own draft. */
export const claudeComposerHasCollapsedPaste = (screen) => COLLAPSED_PASTE_RE.test(composerDraft(screen) ?? "");

/** WHAT: Checks whether a shell script is Claude Code's own clipboard read. WHY: Keeps the same script under a tool shell from ever being signalled. */
export const isClaudeClipboardScript = (script) => CLAUDE_CLIPBOARD_SCRIPT_RE.test(String(script || ""));

/** WHAT: Reads Linux process facts by pid. WHY: Keeps ownership checks on kernel truth that tests can replace. */
export const linuxProcesses = {
  pids: () => readdirSync("/proc").filter((name) => /^\d+$/u.test(name)).map(Number),
  stat(pid) {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = text.lastIndexOf(")");
      const fields = text.slice(close + 2).split(" ");
      return { pid, comm: text.slice(text.indexOf("(") + 1, close), ppid: Number(fields[1]), startTicks: fields[19] };
    } catch (error) {
      if (processGone(error)) return null;
      throw error;
    }
  },
  argv(pid) {
    try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1); }
    catch (error) {
      if (processGone(error)) return null;
      throw error;
    }
  },
  signal: (pid, signal) => process.kill(pid, signal),
};

/**
 * WHAT: Collects the clipboard lookups this pane's own Claude process waits on, with start times.
 * WHY: Keeps signals off Claude, its MCP servers, tool shells and other panes.
 */
export function findClaudeClipboardLookups(panePid, processes = linuxProcesses) {
  const table = processes.pids().map((pid) => processes.stat(pid)).filter(Boolean);
  const childrenOf = (pid) => table.filter((facts) => facts.ppid === pid);
  const isClaude = (facts) => facts && (facts.comm === "claude"
    || basename(processes.argv(facts.pid)?.[0] || "") === "claude");
  const claude = [table.find((facts) => facts.pid === Number(panePid)), ...childrenOf(Number(panePid))].find(isClaude);
  if (!claude) return [];
  return childrenOf(claude.pid)
    .map((facts) => ({ ...facts, argv: processes.argv(facts.pid) || [] }))
    .filter(({ argv }) => SHELL_RE.test(argv[0] || "") && argv[1] === "-c" && isClaudeClipboardScript(argv[2]))
    .map((shell) => ({ ...shell, claudePid: claude.pid, readers: childrenOf(shell.pid) }));
}

/** WHAT: Signals a process only while it keeps the recorded identity. WHY: A reused pid belongs to someone else. */
function signalSame(processes, facts, signal) {
  if (processes.stat(facts.pid)?.startTicks !== facts.startTicks) return false;
  try {
    processes.signal(facts.pid, signal);
    return true;
  } catch (error) {
    if (processGone(error)) return false;
    throw error;
  }
}

/**
 * WHAT: Routes TERM to each recorded lookup shell and its readers, then KILL to surviving readers.
 * WHY: Keeps Claude, its process group and every unrecorded process out of the signal path.
 */
export async function endClaudeClipboardLookups(lookups, { processes = linuxProcesses, wait }) {
  const ended = [];
  const signalled = [];
  for (const shell of lookups) {
    const current = processes.stat(shell.pid);
    if (current?.ppid !== shell.claudePid || processes.argv(shell.pid)?.[2] !== shell.argv[2]) continue;
    // The shell goes first, so its `|| wl-paste` fallback never starts.
    if (!signalSame(processes, shell, "SIGTERM")) continue;
    ended.push(shell.pid);
    signalled.push(shell);
    for (const reader of shell.readers) if (signalSame(processes, reader, "SIGTERM")) ended.push(reader.pid);
  }
  await wait(POLL_MS);
  for (const reader of signalled.flatMap((shell) => shell.readers)) signalSame(processes, reader, "SIGKILL");
  return ended;
}

/**
 * WHAT: Checks a bounded time for Claude to finish a paste, then ends its stalled clipboard lookup.
 * WHY: Prevents a held paste from swallowing typing and Enter; maintenance only reports, never repairs.
 */
export async function settleClaudePaste({
  capture, panePid, wait, mayRelease = true, onReleased = () => {}, processes = linuxProcesses,
  settlePolls = CLAUDE_PASTE_SETTLE_POLLS, landPolls = CLAUDE_PASTE_LAND_POLLS,
}) {
  const pasting = async () => claudeComposerIsPasting(await capture());
  if (!await pasting()) return { ok: true, released: [] };
  if (!mayRelease) {
    return { ok: false, reason: "Claude composer is still Pasting…; maintenance leaves it to the delivery that owns it" };
  }
  for (let poll = 0; poll < settlePolls; poll += 1) {
    await wait(POLL_MS);
    if (!await pasting()) return { ok: true, released: [] };
  }
  const lookups = findClaudeClipboardLookups(Number(await panePid()), processes);
  if (!lookups.length) {
    return { ok: false, reason: "Claude composer is still Pasting… and no clipboard lookup of its own was found" };
  }
  const released = await endClaudeClipboardLookups(lookups, { processes, wait });
  onReleased({ released, scripts: lookups.map((shell) => shell.argv[2]) });
  for (let poll = 0; poll < landPolls; poll += 1) {
    if (!await pasting()) return { ok: true, released };
    await wait(POLL_MS);
  }
  return { ok: false, reason: `Claude composer is still Pasting… after its clipboard lookup ended (pids ${released.join(", ")})` };
}
