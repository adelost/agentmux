import { feature, unit, expect } from "bdd-vitest";
import {
  claudeComposerHoldsPaste, claudeComposerIsPasting, endClaudeClipboardLookups,
  findClaudeClipboardLookups, isClaudeClipboardScript,
} from "./claude-paste-stall.mjs";

const RULE = "─".repeat(160);
// Screens captured from the real Claude Code 2.1.295 in an isolated tmux, 2026-10-10.
const screen = (composer, footer) => ["▎ https://code.claude.com/docs/en/permission-modes", RULE, `❯ ${composer}`, RULE, footer].join("\n");
const PASTING = screen("", "  Pasting…");
const LANDED = screen("[Pasted text #1 +3 lines]", "  paste again to expand");
const IDLE = screen("", "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents");
const QUOTED = ["⏺ The footer said Pasting…", "  Pasting…", RULE, "❯ ", RULE, "  ⏵⏵ bypass permissions on"].join("\n");
const STALLED_JOB = "[from lsrc:1]\n\n/home/adelost/lsrc/.artifacts/cutkit-quality-2026-10-09/e283-share/e283-fore-efter-390.png\n";

// Claude Code 2.1.295's Linux clipboard scripts, copied from the binary.
const PATH_LOOKUP = "xclip -selection clipboard -t text/plain -o 2>/dev/null || wl-paste 2>/dev/null";
const IMAGE_CHECK = 'xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)" || wl-paste -l 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)"';
const IMAGE_SAVE = "xclip -selection clipboard -t image/png -o > /tmp/claude_cli_latest_screenshot.png 2>/dev/null || wl-paste --type image/png > /tmp/claude_cli_latest_screenshot.png 2>/dev/null";

feature("Claude's held paste is recognised from its own screen", () => {
  unit("only the footer under the composer counts as Pasting…", {
    when: ["reading four real screens", () => [PASTING, LANDED, IDLE, QUOTED].map(claudeComposerIsPasting)],
    then: ["the held paste alone is pasting", (result) => expect(result).toEqual([true, false, false, false])],
  });

  unit("a landed paste is this prompt only when its line count matches", {
    when: ["matching the collapsed paste against three prompts", () => [
      claudeComposerHoldsPaste(LANDED, STALLED_JOB),
      claudeComposerHoldsPaste(LANDED, "one\ntwo"),
      claudeComposerHoldsPaste(IDLE, STALLED_JOB),
    ]],
    then: ["only the 3-break prompt owns it", (result) => expect(result).toEqual([true, false, false])],
  });

  unit("only Claude's own clipboard scripts count as its lookup", {
    when: ["classifying Claude's three scripts and three others", () => [PATH_LOOKUP, IMAGE_CHECK, IMAGE_SAVE,
      "xclip -selection clipboard -o", "xclip -selection clipboard -i < notes.txt", "wl-paste || xclip -o"]
      .map(isClaudeClipboardScript)],
    then: ["Claude's three match", (result) => expect(result).toEqual([true, true, true, false, false, false])],
  });
});

/** A process table: skyvw:0's shape (bash, claude, MCP children) plus a tool shell and another pane's lookup. */
function processTable() {
  const table = new Map([
    [10, { comm: "bash", ppid: 1, startTicks: "100", argv: ["-bash"] }],
    [11, { comm: "claude", ppid: 10, startTicks: "101", argv: ["/home/u/.local/bin/claude", "--resume", "x"] }],
    [12, { comm: "sh", ppid: 11, startTicks: "200", argv: ["/bin/sh", "-c", PATH_LOOKUP] }],
    [13, { comm: "xclip", ppid: 12, startTicks: "201", argv: ["xclip", "-selection", "clipboard", "-t", "text/plain", "-o"] }],
    [14, { comm: "bash", ppid: 11, startTicks: "300", argv: ["/bin/bash", "-c", "sh -c 'xclip …'"] }],
    [15, { comm: "sh", ppid: 14, startTicks: "301", argv: ["/bin/sh", "-c", PATH_LOOKUP] }],
    [16, { comm: "npm exec task-m", ppid: 11, startTicks: "302", argv: ["npm", "exec", "task-master-ai"] }],
    [20, { comm: "sh", ppid: 1, startTicks: "400", argv: ["/bin/sh", "-c", PATH_LOOKUP] }],
  ]);
  const signals = [];
  const processes = {
    pids: () => [...table.keys()],
    stat: (pid) => (table.has(pid) ? { pid, ...table.get(pid) } : null),
    argv: (pid) => table.get(pid)?.argv ?? null,
    signal: (pid, signal) => signals.push(`${pid}:${signal}`),
  };
  return { table, signals, processes };
}

feature("only the pane's own Claude lookup is ever signalled", () => {
  unit("the lookup is Claude's direct shell child and its reader", {
    given: ["skyvw:0's process shape", processTable],
    when: ["finding the lookups of pane pid 10", ({ processes }) => findClaudeClipboardLookups(10, processes)
      .map((shell) => ({ pid: shell.pid, claudePid: shell.claudePid, readers: shell.readers.map((reader) => reader.pid) }))],
    then: ["the tool shell's lookup and another pane's lookup are not Claude's", (lookups) =>
      expect(lookups).toEqual([{ pid: 12, claudePid: 11, readers: [13] }])],
  });

  unit("the shell is ended first, then its reader, and a reused pid is left alone", {
    given: ["a recorded lookup whose reader pid was then reused", () => {
      const fixture = processTable();
      fixture.lookups = findClaudeClipboardLookups(10, fixture.processes);
      fixture.table.set(13, { ...fixture.table.get(13), startTicks: "999" });
      return fixture;
    }],
    when: ["ending the recorded lookups", async ({ lookups, processes }) =>
      endClaudeClipboardLookups(lookups, { processes, wait: async () => {} })],
    then: ["only the shell got a signal; Claude, its group and everyone else got none", (ended, { signals }) => {
      expect(ended).toEqual([12]);
      expect(signals).toEqual(["12:SIGTERM"]);
    }],
  });
});
