// tmux adapter: the ONLY place that builds tmux command strings.
//
// Every primitive owns its quoting/escaping. Historically ~40% of agent.mjs
// fixes were quoting, copy-mode and respawn races at raw `tmux(...)` call
// sites; centralizing the string-building turns that whole bug class into
// one tested surface. Callers speak intent (capture, sendLiteral, respawn),
// never tmux syntax.
//
// Escaping contract:
// - Targets, names, paths and literal text are escaped here, always.
// - runShell(line) wraps the line in single quotes VERBATIM (no escaping):
//   callers compose `cd ${esc(dir)} && ${cfg.cmd}` where cfg.cmd comes from
//   agentmux.yaml and may legitimately contain quotes. Same semantics as the
//   historical inline calls, now documented in exactly one place.
// - sendKeys(keySpec) passes raw key tokens ("Enter", "Down Enter", "-X cancel")
//   untouched; specs come from code (dismiss.mjs), never user input.

import { esc } from "../lib.mjs";

export function createTmuxAdapter({ socket, exec }) {
  const raw = (cmd) => exec(`tmux -S '${esc(socket)}' ${cmd}`);
  const q = (s) => `'${esc(String(s))}'`;

  // Local functions, not `this.`-methods: every primitive stays safe to
  // destructure or pass as a bare callback (`panes.map(t.paneDead)`), which
  // an object literal with `this` silently is not.
  async function display(target, format) {
    const { stdout } = await raw(`display-message -t ${q(target)} -p '${format}'`);
    return stdout.trim();
  }

  async function sendKeys(target, keySpec) {
    await raw(`send-keys -t ${q(target)} ${keySpec}`);
  }

  return {
    /** Escape hatch for not-yet-migrated call sites. Prefer a primitive. */
    raw,

    // --- Sessions ---

    async hasSession(name) {
      try { await raw(`has-session -t ${q(name)}`); return true; }
      catch { return false; }
    },

    async newSession(name) {
      await raw(`new-session -d -s ${q(name)}`);
    },

    async sourceUserConf() {
      await raw(`source-file ~/.tmux.conf`);
    },

    // --- Global environment ---

    /** Names in tmux's global environment (for leak-scrubbing). */
    async globalEnvNames() {
      const { stdout } = await raw(`show-environment -g`);
      return stdout.split("\n").map((l) => l.split("=")[0]).filter(Boolean);
    },

    async unsetGlobalEnv(name) {
      await raw(`set-environment -g -u ${q(name)}`);
    },

    // --- Window geometry / layout ---

    async setWindowSizeManual(name) {
      await raw(`set-window-option -t ${q(name)} window-size manual`);
    },

    async setWindowSizeLatest(name) {
      await raw(`set-window-option -t ${q(name)} window-size latest`);
    },

    async resizeWindow(name, cols, rows) {
      await raw(`resize-window -t ${q(name)} -x ${Number(cols)} -y ${Number(rows)}`);
    },

    async selectLayout(name, layout) {
      await raw(`select-layout -t ${q(name)} ${q(layout)}`);
    },

    // --- Panes ---

    /** Horizontal split with cwd pinned (see setupPanes for why -c is mandatory). */
    async splitWindowRight(target, cwd) {
      await raw(`split-window -t ${q(target)} -h -c ${q(cwd)}`);
    },

    async selectPane(target) {
      await raw(`select-pane -t ${q(target)}`);
    },

    async paneCount(name) {
      const { stdout } = await raw(`list-panes -t ${q(name)}`);
      return stdout.trim().split("\n").length;
    },

    /** One #{...} format value for a pane, trimmed. */
    display,

    async currentCommand(target) {
      return display(target, "#{pane_current_command}");
    },

    async paneInMode(target) {
      return (await display(target, "#{pane_in_mode}")) === "1";
    },

    async paneDead(target) {
      return (await display(target, "#{pane_dead}")) === "1";
    },

    async panePid(target) {
      return display(target, "#{pane_pid}");
    },

    /** respawn-pane. kill=true forces; cwd pins the new shell's directory. */
    async respawnPane(target, { kill = false, cwd = null } = {}) {
      const killFlag = kill ? " -k" : "";
      const cwdFlag = cwd ? ` -c ${q(cwd)}` : "";
      await raw(`respawn-pane${killFlag} -t ${q(target)}${cwdFlag}`);
    },

    // --- Capture ---

    /**
     * Pane text, raw stdout (no ANSI stripping here; that's text-processing,
     * not tmux I/O). join=true (-J) merges wrapped lines so narrow panes
     * don't split logical lines (see capturePane in agent.mjs).
     */
    async capture(target, { lines = 50, join = true } = {}) {
      const joinFlag = join ? " -J" : "";
      const { stdout } = await raw(`capture-pane -t ${q(target)}${joinFlag} -p -S -${Number(lines)}`);
      return stdout;
    },

    // --- Keys ---

    /** Literal text into the composer (fully escaped, -l -- stops option parsing). */
    async sendLiteral(target, text) {
      await raw(`send-keys -t ${q(target)} -l -- ${q(text)}`);
    },

    /** Raw key tokens verbatim: "Enter", "Escape", "Down Enter", ... */
    sendKeys,

    async sendEnter(target) {
      await sendKeys(target, "Enter");
    },

    async sendEscape(target) {
      await sendKeys(target, "Escape");
    },

    /** Exit copy/view/choose mode without leaking a keystroke (-X cancel). */
    async cancelCopyMode(target) {
      await raw(`send-keys -X -t ${q(target)} cancel`);
    },

    /**
     * Run a command line in a shell pane: send-keys '<line>' Enter.
     * The line is wrapped in single quotes VERBATIM (see escaping contract).
     */
    async runShell(target, line) {
      await raw(`send-keys -t ${q(target)} '${line}' Enter`);
    },

    // --- Buffers (long-prompt paste path) ---

    async loadBuffer(bufName, file) {
      await raw(`load-buffer -b ${q(bufName)} ${q(file)}`);
    },

    async pasteBuffer(bufName, target) {
      await raw(`paste-buffer -b ${q(bufName)} -t ${q(target)}`);
    },
  };
}
